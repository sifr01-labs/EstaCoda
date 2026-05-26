---
title: CLI Commands
description: Operational reference for the estacoda CLI command surface.
sidebar_position: 1
---

# CLI Commands

EstaCoda is a command-line agent system. Every surface that mutates state, inspects configuration, or changes runtime behavior is reachable from the terminal. This page documents the implemented command families. It does not document planned or pending behavior.

## Global option

```bash
estacoda --profile <id> <command>
estacoda -p <id> <command>
```

The `--profile` / `-p` flag selects a profile for the current command only. It does not change `active-profile.json`. Only `estacoda profile use <name>` changes the active profile. The flag is valid before any command.

---

## Setup and onboarding

### `estacoda setup`

Opens the reviewed setup, repair, and onboarding flow. This is the canonical path for first-run configuration and later repair.

```bash
estacoda setup                          # interactive setup/repair
estacoda setup --interactive            # explicit interactive mode
estacoda setup --advanced               # advanced options in interactive mode
estacoda setup --provider <p> --model <m> --api-key-env <env>
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json`
- `~/.estacoda/profiles/<id>/.env` (credential references, not raw values)
- `~/.estacoda/profiles/<id>/trust.json`

**Profile boundary:** Uses the active profile, or the profile selected via `--profile`.

**Behavior:** Routes through a deterministic setup decision based on current state (first-run, configured-ready, configured-degraded, partial-provider, missing-credential, broken-config, untrusted-workspace, state-not-writable). Cancelling review produces no mutation. Raw secrets are never displayed in review metadata.

**Failure modes:**
- Broken config blocks normal edits until parsing is safe.
- State-not-writable blocks writes until permissions are fixed.
- Missing credentials route to credential repair without collecting raw values inline.

### `estacoda init`

Bootstraps state directories and default config.

```bash
estacoda init                           # create state skeleton
estacoda init --home <dir>              # custom state home
estacoda init --yes                     # non-interactive; use defaults
```

**State touched:** `~/.estacoda/`, default profile skeleton, `active-profile.json`.

**Failure modes:** Directory creation failures surface as exit code 1 with the path that failed.

### `estacoda verify`

Runs read-only verification of setup readiness.

```bash
estacoda verify
```

Checks:
- Provider config syntax validity
- Provider credential and endpoint readiness
- State directory backup readiness
- Pack registry validity

**Exit code:** 0 if ready, 1 if warnings exist.

---

## Model and provider

### `estacoda model`

The model command family manages which LLM EstaCoda uses, how credentials are loaded, and what happens when the primary route fails.

```bash
estacoda model                          # interactive picker or overview
estacoda model status                   # primary, fallback, and auxiliary route status
estacoda model list                     # configurable models in the catalog
estacoda model list --live              # include live network probes
estacoda model search <query>           # search catalog by name or provider
estacoda model providers                # list known providers
estacoda model refresh                  # refresh provider catalog from network
estacoda model diagnose                 # full diagnostic with executable status
estacoda model auxiliary status         # auxiliary route readiness
estacoda model fallback                 # manage fallback chain
estacoda model setup local              # configure local Ollama/OpenAI-compatible endpoint
estacoda model setup custom             # configure custom OpenAI-compatible endpoint
estacoda model setup codex              # OAuth device-code setup for Codex
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json` (primary route, fallback chain, provider registration)
- `~/.estacoda/profiles/<id>/.env` (env var references)
- `~/.estacoda/auth.json` (Codex OAuth tokens)

**Profile boundary:** All model config is profile-scoped.

**Behavior:**
- Bare `estacoda model` opens an interactive picker in setup mode when a TTY is available; otherwise prints an overview.
- `model setup codex` authenticates through OAuth device code flow, stores tokens in `~/.estacoda/auth.json`, and configures the `codex/o3` route.
- `model fallback` manages the ordered fallback chain. `estacoda model set` is deprecated and rejected.

**Failure modes:**
- Unknown model input returns exit code 1 with candidate suggestions.
- Ambiguous input lists matching candidates.
- Credential required but no prompt available returns a repair instruction.
- Config save failures report the path and error.

---

## Profile management

Profiles isolate configuration, secrets, identity memory, skills, cron state, gateway state, logs, caches, and channel media under `~/.estacoda/profiles/<id>/`.

```bash
estacoda profile create <name>
estacoda profile create <name> --blank
estacoda profile create <name> --from <profile> --files user,memory,soul
estacoda profile list
estacoda profile use <name>
estacoda profile show [name]
estacoda profile delete <name>
estacoda profile delete <name> --force
estacoda profile rename <old> <new>
```

**State touched:**
- `~/.estacoda/profiles/<id>/` (full skeleton)
- `~/.estacoda/active-profile.json`

**Profile boundary:** `profile use` changes the global active profile. All other profile commands operate on the named profile.

**Failure modes:**
- `profile delete` refuses active or non-empty profiles unless `--force` is provided.
- `profile rename` updates the active profile record when the renamed profile was active.

---

## Gateway and channels

### `estacoda gateway`

Manages the channel gateway lifecycle, service installation, and diagnostics.

```bash
estacoda gateway start                  # foreground gateway supervisor
estacoda gateway start --dry-run        # readiness check; no PID/lock writes
estacoda gateway start --background     # detached background process
estacoda gateway start --profile <id>   # bind gateway to a specific profile
estacoda gateway stop                   # SIGTERM; prefers managed service if installed
estacoda gateway stop --force           # SIGKILL for unmanaged; systemd stop for managed
estacoda gateway restart                # stop then background-start
estacoda gateway restart --graceful     # alias for restart in v0.1.0
estacoda gateway restart --system       # restart system-scope service
estacoda gateway status                 # full status: service manager, channels, cron, approvals
estacoda gateway diagnose               # per-channel readiness; exits 1 on warnings
estacoda gateway approvals              # pending approvals count
estacoda gateway install                # install user-scope systemd/launchd service
estacoda gateway install --force        # replace existing service unit
estacoda gateway install --profile <id> # install service bound to profile
estacoda gateway install --system --run-as-user <user>
estacoda gateway uninstall              # remove user-scope service
estacoda gateway uninstall --system     # remove system-scope service
```

**State touched:**
- `~/.estacoda/profiles/<id>/gateway.pid`
- `~/.estacoda/profiles/<id>/gateway.lock`
- `~/.estacoda/profiles/<id>/gateway-state/`
- systemd user units / launchd plists (when managed)

**Profile boundary:** Gateway processes bind to the profile selected at start time. Changing `active-profile.json` does not mutate a running gateway.

**Failure modes:**
- `start --background` refuses to spawn if a live PID file or active gateway lock exists.
- `stop` prefers a managed user-scope service; if only a system service exists, rerun with `--system`.
- systemd user services may stop on logout unless linger is enabled.
- Source-mode installs hardcode the absolute workspace path; moving the repo requires reinstall.

### `estacoda channels`

```bash
estacoda channels list                  # compact table of all channels
estacoda channels status <name>         # detailed status for one channel
estacoda channels enable <name>         # set enabled: true in config
estacoda channels disable <name>        # set enabled: false in config
```

Valid channel names: `telegram`, `discord`, `email`, `whatsapp` (case-insensitive).

**State touched:** `~/.estacoda/profiles/<id>/config.json` (channel block).

**Failure modes:** Invalid channel names return exit code 1.

---

## Cron

```bash
estacoda cron list                      # all jobs with schedule and next run
estacoda cron show <job-id>             # job detail + last 5 executions
estacoda cron history [job-id]          # execution history
estacoda cron run <job-id>              # request a manual run
estacoda cron pause <job-id>
estacoda cron resume <job-id>
estacoda cron remove <job-id>
estacoda cron tick                      # manual scheduler tick
```

**State touched:**
- `~/.estacoda/profiles/<id>/cron/jobs.json`
- `~/.estacoda/sessions.sqlite` (execution history)
- `~/.estacoda/profiles/<id>/cron/output/`

**Profile boundary:** Cron jobs are profile-scoped.

**Failure modes:**
- Stale locks from crashed processes are recovered on startup.
- Cron jobs cannot schedule more cron jobs (recursion guard).
- Delivery failures are classified and persisted in execution history.

---

## Sessions

```bash
estacoda sessions list                  # recent sessions with attached surfaces
estacoda sessions show <session-id>     # session detail + surface pointers
estacoda sessions current               # current runtime session
estacoda sessions attach <surface> <id> <session-id>
estacoda sessions detach <surface> <id>
estacoda sessions recall <query>        # summarize historical session matches
estacoda session recall <query>         # alias
estacoda sessions compact <session-id> [--topic <topic>]
```

Valid surfaces: `cli`, `telegram`, `discord`, `whatsapp`, `email`.

**State touched:** SQLite session DB (`~/.estacoda/sessions.sqlite`).

**Profile boundary:** Sessions are profile-scoped. `sessions recall` is bounded to the active profile and workspace when metadata is available.

**Failure modes:**
- `sessions compact` is non-rotating in this implementation; it does not adopt a compacted child session.
- Attach/detach requires the session to exist in the active profile.

---

## TaskFlow

Requires SQLite session persistence. In-memory session DB rejects TaskFlow commands.

```bash
estacoda flow list                      # active (non-terminal) flows
estacoda flow show <flowId>
estacoda flow status <flowId>
estacoda flow trace <flowId> [limit]
estacoda flow pause <flowId> [reason]
estacoda flow resume <flowId>
estacoda flow interrupt <flowId> [reason]
estacoda flow cancel <flowId> [reason]
estacoda flow steer <flowId> <instruction>
estacoda flow approve <stepId>
estacoda flow reject <stepId> [reason]
estacoda flow retry <stepId>
estacoda flow skip <stepId> [reason]
estacoda flow checkpoint <flowId> <name>
estacoda flow compact <flowId>
```

**State touched:** SQLite session DB (`flow_events`, `flow_steps` tables).

**Failure modes:**
- Retry only works if `idempotent` or `safeToRetry` is true and under `maxRetries`.
- Skip only works if the step has not started and `allowSkipIfSkippable` is true.
- Steer is rejected for flows in terminal states.
- Interrupt sends SIGTERM with 5s timeout to active processes, then transitions state.

---

## Security and approvals

```bash
estacoda security                       # view current security mode
estacoda security --mode <mode>         # set approval mode
```

Valid modes: `strict`, `normal`, `open`. Hard safety blocks apply in all modes.

**State touched:** `~/.estacoda/profiles/<id>/config.json`.

---

## Tools and MCP

```bash
estacoda tools                          # list available tools grouped by toolset
estacoda mcp status                     # configured MCP servers and readiness
estacoda mcp reload                     # reload MCP config
```

**State touched:** None for `tools`. `mcp reload` refreshes the runtime tool registry from current config.

**Failure modes:** MCP servers missing from config are not errors; they simply do not appear.

---

## Diagnostics

```bash
estacoda doctor                         # config readiness and provider diagnostics
estacoda doctor --live                  # includes live provider endpoint probes
```

**Exit code:** 0 if ready, 1 if warnings exist.

---

## Trace and eval

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
estacoda eval [fixture-id]
```

**State touched:** SQLite session DB (trajectory storage).

**Failure modes:** `--raw` bypasses redaction. Use with care.

---

## Packs and skills

```bash
estacoda packs list                     # installed packs
estacoda packs inspect <id>             # full manifest and metadata
estacoda packs install <path>           # install from local path
estacoda packs enable <id>
estacoda packs disable <id>
estacoda packs uninstall <id>

estacoda skills list                    # available skills from enabled packs
estacoda skills inspect <name>          # skill metadata
estacoda skills view <name>             # full SKILL.md content
```

**State touched:**
- `~/.estacoda/profiles/<id>/packs.json`
- `~/.estacoda/packs/` (shared pack storage)

**Profile boundary:** Packs are installed globally; enablement is per-profile. Skills visibility depends on enabled packs.

---

## Settings

```bash
estacoda settings                       # overview of all categories
estacoda settings profile               # profile mode and response language
estacoda settings profile --mode <mode> --response-language <lang>
estacoda settings ui                    # UI language, flavor, activity labels
estacoda settings ui --language <en|ar> --flavor <f> --activity-labels <l>
estacoda settings skills                # skill autonomy
estacoda settings skills --autonomy <level>
estacoda settings security              # security mode
estacoda settings browser               # browser backend config
estacoda settings voice                 # voice provider readiness
estacoda settings image                 # image generation config
estacoda settings telegram              # Telegram channel config
estacoda settings provider              # provider diagnostic summary
```

**State touched:** `~/.estacoda/profiles/<id>/config.json`.

---

## Knowledge, evolution, curator, manifest, proposal

Development-facing command families. They operate on skill manifests, knowledge graphs, and evolution proposals.

```bash
estacoda knowledge <subcommand>
estacoda evolution <subcommand>
estacoda curator <subcommand>
estacoda manifest diff <id>
estacoda proposal <subcommand>
```

These are advanced surfaces. Run `--help` on each for subcommands.

---

## Update

```bash
estacoda update --check                 # check only; never modify files
estacoda update                         # apply update (managed-source) or print routing
estacoda update --backup                # force backup before applying
estacoda update --no-backup             # skip user-state backup
estacoda update --gateway               # non-interactive gateway/service update mode
```

**Install-method routing:** `estacoda update` detects how EstaCoda was installed and routes accordingly.

| Method | Behavior |
|---|---|
| `managed-source` | Guarded source update: fetch, ff-only check, worktree check, pull, install deps, build, validate. Rollback on failure. |
| `manual-source` | Check and advise only. No self-mutation. |
| `homebrew` | Print `brew upgrade kemetresearch/tap/estacoda`. |
| `docker` | Print `docker pull ghcr.io/kemetresearch/estacoda:latest`. |
| `npm-global` | Print `npm install -g estacoda@latest`. |
| `pnpm-global` | Print `pnpm add -g estacoda@latest`. |
| `unknown` | Print reinstall guidance. |

**State touched:**
- `~/.estacoda/update-cache.json` — update check cache
- `~/.estacoda/logs/update.log` — update operation log (gateway mode)
- `~/.estacoda/.backups/<label>/` — user-state backup before managed-source mutation

**Exit codes:** 0 on success/routing, 1 on error, 2 if up-to-date, 3 if dirty worktree.

**Related docs:** [Updating](../getting-started/updating.md), [Update Operations](../operations/update-operations.md)

## Uninstall

```bash
estacoda uninstall                      # keep data; remove code/wrappers/services
estacoda uninstall --purge --yes        # remove user data too
```

**Behavior:** Default mode removes managed-source install code, known wrappers, installer-owned PATH entries, and gateway services while preserving `~/.estacoda`. `--yes` alone does not purge. Full data deletion requires both `--purge` and `--yes`.

**Install-method routing:**

| Method | Behavior |
|---|---|
| `managed-source` | Gateway teardown, remove wrappers/PATH lines, remove install dir (if stamp is trusted), preserve `~/.estacoda` |
| `manual-source` | Gateway teardown, remove wrappers/PATH lines, preserve clone and `~/.estacoda` |
| `homebrew` | Print `brew uninstall estacoda` |
| `docker` | Print container/image guidance |
| `npm-global` | Print `npm uninstall -g estacoda` |
| `pnpm-global` | Print `pnpm remove -g estacoda` |
| `unknown` | Remove known wrappers/PATH lines, preserve user data |

**State touched:** May remove install directory, wrappers, PATH entries, gateway services. With `--purge --yes`, removes `~/.estacoda`.

**Related docs:** [Uninstall](../getting-started/uninstall.md)

---

## Version and help

```bash
estacoda --version
estacoda -v
estacoda --help
estacoda -h
estacoda help
```

---

## ACP server

```bash
estacoda acp                            # start the ACP stdio server
```

Starts the Agent Communication Protocol stdio server for external integration.

---

## Handoff

```bash
estacoda handoff <surface>
```

Generates a handoff code to share the current CLI session with a channel surface. Currently only `telegram` is supported.

**State touched:** `~/.estacoda/profiles/<id>/gateway-state/handoff-codes.json`.

---

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error, warning, or command rejected |
| 2 | Up-to-date (update command) |
| 3 | Dirty worktree; stash or commit before retrying (update command) |

Most commands exit 0 on success and 1 on any failure, diagnostic warning, or invalid input. The update command uses 2 when already up-to-date and 3 when the managed-source worktree has uncommitted changes. The gateway family follows the same convention.

---

## Related docs

- [Slash Commands](./slash-commands.md) — in-session command reference
- [Tools Reference](./tools-reference.md) — tool classes and availability boundaries
- [State and Files](./state-and-files.md) — where profile state lives
- [Provider Reference](./provider-reference.md) — model provider maturity and setup
