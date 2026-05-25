---
title: CLI
description: Interactive CLI, sessions, slash commands, and terminal behavior for v0.1.0.
sidebar_position: 1
---

# CLI

The CLI is the supported direct interaction surface for EstaCoda. It runs an interactive terminal session, executes one-shot commands, and exposes operational controls for setup, inspection, and recovery.

This page explains how the CLI behaves, what it renders, and where it fails.

---

## What the CLI Is

`estacoda` without arguments starts an interactive session. The session loop reads input, dispatches to the runtime, and renders output through a terminal-native pipeline.

The CLI is not a chat wrapper. It is a stateful agent command surface with explicit sessions, profile boundaries, approval prompts, and rendering contracts.

---

## Starting and Resuming

```bash
# Start interactive session
estacoda

# Run a one-shot command
estacoda --profile work "explain this file"

# Select a profile for this command only
estacoda --profile work model status
estacoda -p work doctor
```

`--profile` / `-p` selects a profile for the current command only. It does not change the active profile on disk. Only `estacoda profile use <name>` updates `~/.estacoda/active-profile.json`.

CLI startup restores the active workspace session from the session store. Fresh launches are no longer forced back to a default scaffold session.

---

## Setup and Verification

```bash
estacoda setup              # Canonical setup entrypoint
estacoda verify             # Verify configuration
estacoda settings           # Show current settings
estacoda doctor --live      # Live provider check
```

`estacoda setup` is the canonical setup entrypoint. Bare `estacoda` launch routes to setup when configuration is incomplete.

Setup is reviewed, not autonomous. It builds a manifest before apply, stores credentials as env var references in the selected profile `.env` with `0600` permissions, and performs read-only verification after apply. Raw secrets are not displayed in review output.

---

## Trace and Eval

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
```

- `list` shows recent trajectories with session IDs and outcomes.
- `dump` outputs full JSON, redacted by default.
- `timeline` outputs chronological human-readable events.
- `failures` lists classified failures for a trajectory.
- `--raw` bypasses redaction. Use with care.

```bash
estacoda eval [fixture-id]
```

Runs deterministic eval fixtures and returns pass/fail per assertion with timing.

---

## Session Recall and Compaction

```bash
estacoda session recall <query>
estacoda sessions recall <query>
estacoda sessions compact <session-id> [--topic <topic>]
```

Recall commands summarize historical session matches. They use the selected profile, apply workspace scoping when a workspace root is available, and fall back to deterministic snippets if auxiliary summarization fails.

`sessions compact` calls semantic session compression for a target session. It is non-rotating in this implementation; it does not create or adopt a compacted child session.

---

## Interactive Slash Commands

Inside an active session, slash commands provide operational controls. This is a high-level overview; the full inventory lives in the reference documentation.

| Command | Purpose |
|---------|---------|
| `/sessions` | List active sessions |
| `/search <query>` | Search session history |
| `/session recall <query>` | Summarize historical session matches |
| `/compact [topic]` | Compact in-session context |
| `/model` | Show ready/runnable model choices |
| `/model <provider>/<model>` | Set a session-scoped model override |
| `/model clear` | Clear the session-scoped model override |
| `/switch <session-id>` | Switch to another session |
| `/reset` | Start a fresh session |
| `/trust` | Show workspace trust status |
| `/yolo` | Toggle open approval mode |
| `/skills` | List visible skills |
| `/tools` | List available tools |
| `/security` | Show recent security decisions |
| `/security debug` | Detailed security audit |
| `/cron` | List scheduled tasks |
| `/approvals` | Show current approvals |
| `/revoke <approval-id>` | Revoke a persistent approval |
| `/reload-mcp` | Reload MCP servers |
| `/exit` | Exit session |

`/model` is session-scoped by default. `/model --global <provider>/<model>` persists the route as the profile primary model after trust checks. `/model --global clear` is rejected; use `estacoda model setup` for primary route management.

---

## Approval Prompts

When a tool execution reaches an approval gate, the CLI accepts these bare answers:

- `once` — grant this exact action one time.
- `session` — grant matching actions for the current session.
- `always` — persist a workspace approval for matching actions.
- `deny`, `reject`, `no`, `n` — deny the action without retry.

Slash-style aliases are also accepted inside the prompt:

- `/approve once`
- `/approve session`
- `/approve always`
- `/deny`

These normalize into the same grant path. Invalid input such as `/approve banana` follows the invalid-answer guidance path and does not grant approval.

---

## Rendering and Terminal Behavior

CLI output flows through a three-stage pipeline:

```text
Runtime Data → ViewModel → Renderer → Output
```

Two renderers exist:

| Renderer | Mode | ANSI | Unicode | Emoji | Animation |
|----------|------|------|---------|-------|-----------|
| Plain | `plain` | No | No | No | No |
| Standard | `standard` | Yes | Yes | Skin-controlled | Capability-gated |

Plain mode is chosen when any of the following is true:
- `--plain` flag
- Not a TTY
- CI environment
- `TERM=dumb`
- Color unsupported

Standard mode requires TTY, color support, non-CI, and non-dumb terminal.

Environment variables that affect rendering:

| Variable | Effect |
|----------|--------|
| `NO_COLOR` | Disables all ANSI color |
| `FORCE_COLOR` | Overrides color detection |
| `TERM=dumb` | Disables color and animation |
| `COLUMNS` | Overrides terminal width |
| `ESTACODA_THEME` | `light` or `dark` |
| `ESTACODA_MODE` | `plain` or `standard` |
| `ESTACODA_SKIN` | `kemetBlue` |

Standard mode uses Unicode box-drawing for panels, ANSI colors from the theme, and spinner frames for running tasks. Plain mode uses ASCII-only markers and semantic text labels.

---

## Failure Modes

**Missing config:** `estacoda` routes to setup. Run `estacoda setup` to repair.

**Provider not configured:** The runtime reports a broken route. Run `estacoda model setup` or `estacoda doctor --live` to diagnose.

**Approval required:** Respond to the prompt with `once`, `session`, `always`, or `deny`. Check `/approvals` for current grants. Use `/revoke <id>` to remove persistent grants.

**Unsafe command denied:** The command matched a hardline block. Change the command; the hardline floor cannot be overridden.

**Terminal/rendering limitations:** Plain mode falls back automatically. If output looks wrong, check `TERM`, `NO_COLOR`, and terminal width.

---

## Inspection and Recovery

```bash
# Current settings and model status
estacoda settings
estacoda model status

# Security decisions
/security
/security debug

# Session state
/sessions
/switch <session-id>

# Approval state
/approvals

# Gateway readiness
estacoda gateway diagnose
```

---

## Related

- [Sessions](./sessions.md) — session lifecycle and state ownership
- [Profiles](./profiles.md) — profile boundaries and switching
- [Tools](./tools.md) — tool execution and availability
- [Security and Approvals](./security-and-approvals.md) — approval modes and the hardline floor
