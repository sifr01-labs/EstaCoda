---
title: "Operator Controls"
description: "Slash commands and CLI commands for controlling durable Tasks, gateway, cron, sessions, and channels."
---

# Operator Controls

## Durable Task Commands

### In-Session Slash Commands

The interactive command operates only on Tasks linked to the current session. Reads allow any session link; pause, resume, cancel, and retry require the creator link.

```text
/task begin <objective>
/task list [limit]
/task show <task-id>
/task pause <task-id>
/task resume <task-id>
/task cancel <task-id>
/task retry <task-id> [step-id]
/task result <task-id>
```

`/task begin` creates a conservative, fixed one-Step Task owned by the current session. It never grants broader authority than the runtime policy. Pause stops new work from being claimed at a safe boundary; cancellation is durable and requests cancellation of active Attempts. Retry is explicit and creates a new Attempt for the existing Step when budget remains.

### Top-Level CLI Commands

```bash
estacoda task begin [--session <session-id>] <objective>
estacoda task list [limit]
estacoda task show <task-id>
estacoda task pause <task-id>
estacoda task resume <task-id>
estacoda task cancel <task-id>
estacoda task retry <task-id> [step-id]
estacoda task result <task-id>
```

Standalone `task begin` requires a trusted workspace and always creates an executable, session-owned Task. Without `--session`, it creates and prints a visible profile-owned creator session; with `--session`, it validates and uses that existing session. `--profile` remains command-local. The status surface reports bounded progress, running/waiting counts, usage and pricing completeness, workspace trust, result count, and background-host state without printing workspace paths, prompts, tool arguments, credentials, or full result bodies.

## Gateway Operator Commands

### Status and Diagnostics

```bash
estacoda gateway status       # Full gateway status
estacoda gateway diagnose     # Per-channel readiness check
```

`gateway status` surfaces:
- Service Manager state for managed gateway services
- Process state (CLI view)
- All configured channels (Telegram, Discord, Email, WhatsApp) with ready/configured/disabled state
- DeliveryRouter platforms
- Active surface pointers
- Pending approvals count
- Cron job summary
- Memory finalization queue counts: pending, running, retrying, failed
- Recent cron failures (last 5)
- Recent delivery errors (last 5)
- Missing config/env warnings
- Durable Task counts and bounded worker summaries when a runtime exposes active Attempts

The Service Manager block reports installed/active state for the user service and, on systemd hosts, the system service scope too. Status remains usable when `systemctl` or `launchctl` probing fails or is permission-limited; failed probes degrade to an unknown/not-installed state instead of failing the whole status command.

`gateway diagnose` checks:
- Telegram token presence, allowed users/chats
- Discord token presence
- Email IMAP/SMTP hosts, username, password, ownAddress, homeAddress
- WhatsApp unofficial-API gate, isolated bridge package/readiness, auth dir writability, device pairing, user-authorization state, `dmPolicy`, `groupPolicy`, `mode`, and queue pressure
- Cron directory permissions (jobs file readable, output/lock dirs writable)

Returns exit code 1 if any warnings exist.

### Gateway Run, Start, Stop, and Restart

```bash
estacoda gateway run                 # Run gateway supervisor in the foreground
estacoda gateway run --dry-run       # Local readiness check; no lock/PID writes
estacoda gateway run --once          # Perform one supervisor pass, then exit
estacoda gateway run --profile work  # Run foreground gateway bound to a selected profile

estacoda gateway start               # Start installed user-scope service
estacoda gateway start --system      # Start installed system-scope service

estacoda gateway stop           # Send SIGTERM and wait for shutdown
estacoda gateway stop --force   # Force termination if graceful stop is not desired or fails

estacoda gateway restart              # Restart installed user-scope service
estacoda gateway restart --system     # Restart installed system-scope service
estacoda gateway restart --graceful   # Alias for restart in v0.1.0
```

`run` starts the gateway supervisor in the foreground. Use it for debugging, local development, and short-lived operator sessions where logs should stay attached to the current terminal.

`run --dry-run` performs local readiness checks without starting adapters, polling remote APIs, entering the supervisor loop, acquiring the gateway lock, or writing PID/lock state. It reports adapter readiness, state directory readiness, and gateway lock state.

`run --once` executes one supervisor pass and exits. It is useful for tests, diagnostics, and controlled handoff checks.

`start` starts an installed service. It defaults to the selected profile's user-scope service. `start --system` controls only the system-scope service. If only a system service exists and `--system` is omitted, EstaCoda fails closed and tells the operator to rerun with `--system`; it will not silently control a privileged unit.

`gateway install` is required before `gateway start`. For an attached foreground gateway, use `gateway run`. `gateway start --background` is deprecated and no longer spawns an unmanaged detached process; replace it with `gateway install` followed by `gateway start`.

Gateway processes are bound to the profile selected at run or service-install time. Changing `active-profile.json` does not mutate a running gateway.

`stop` first checks whether the selected profile has an installed managed service. If a user-scope service exists, `stop` delegates to systemd or launchd. On systemd, `stop --force` still uses `systemctl stop`; it does not send SIGKILL to the supervisor directly. If no managed service exists, `stop` reads the PID from `gateway.pid`, sends SIGTERM, waits up to 10s for exit, then removes PID/state/lock files. In that unmanaged process mode, `--force` sends SIGKILL and cleans up.

`restart` uses the same service selection rules as `start`. If a user-scope service exists, it delegates to systemd or launchd. `restart --system` controls only the system-scope service. If no managed service exists, `restart` fails with installation guidance and does not create an unmanaged detached process. In v0.1.0, `restart --graceful` is an alias for `restart`; it does not add a separate drain behavior.

### Gateway Managed Services

```bash
estacoda gateway install                  # Install user-scope service for the selected profile
estacoda gateway install-service          # Alias for install
estacoda gateway install --profile work   # Install a service bound to profile "work"
estacoda gateway install --force          # Stop and replace an existing service unit

sudo estacoda gateway install --system --run-as-user estacoda
sudo estacoda gateway install --system --run-as-user estacoda --home /home/estacoda

estacoda gateway uninstall                # Remove user-scope service for the selected profile
estacoda gateway uninstall-service        # Alias for uninstall
estacoda gateway uninstall --profile work # Remove the service for profile "work"
sudo estacoda gateway uninstall --system  # Remove system-scope service

estacoda gateway stop --system            # Stop a system-scope service
estacoda gateway restart --system         # Restart a system-scope service
estacoda gateway start --system           # Start a system-scope service
```

Supported service managers:

- Linux systemd user services.
- Linux systemd system services.
- macOS launchd user LaunchAgents.

Installed gateway services are profile-aware. The generated service launch command includes `gateway run --profile <profileId>`, and each profile receives its own hash-suffixed unit or plist name, so multiple profiles can have independent managed services.

Gateway services use two homes:

| Concept | Meaning |
|---------|---------|
| `stateHomeDir` / `estacodaHomeDir` | EstaCoda state root. Holds profile config, profile-local `.env`, sessions, gateway state, logs, and cron files. Generated services receive this as `ESTACODA_HOME`. |
| `serviceUserHomeDir` / `osHomeDir` | Real OS user home. Holds systemd user units, launchd plists, and the generated service `HOME`. |

With this environment:

```bash
HOME=/home/agent ESTACODA_HOME=/srv/estacoda-state
```

the service uses:

```text
EstaCoda state:
  /srv/estacoda-state/.estacoda/...

Service files:
  /home/agent/.config/systemd/user/...
  /home/agent/Library/LaunchAgents/...

Generated service environment:
  ESTACODA_HOME=/srv/estacoda-state
  HOME=/home/agent
```

System-scope installs require root and an explicit `--run-as-user <user>`. EstaCoda validates the username, verifies the user exists with `id -u`, and resolves the service `HOME` with `getent passwd <user>`. Pass `--home <absolute-dir>` when the run-as user's OS home cannot be resolved or should be overridden. `--home` is a service-user OS-home override; it is not the EstaCoda state home unless `ESTACODA_HOME` is also set to the same path. EstaCoda does not insert `sudo` for you; run the install command with the privilege model you intend.

Example:

```bash
sudo ESTACODA_HOME=/srv/estacoda-state \
  estacoda gateway install --system --run-as-user estacoda --home /var/lib/estacoda
```

In that command, `/var/lib/estacoda` is the service user's OS home and generated `HOME`. EstaCoda state remains under `/srv/estacoda-state/.estacoda`.

Operational warnings:

- Services set `ESTACODA_HOME` for state and `HOME` for the OS/service user. They do not inherit your interactive shell environment.
- Put bot tokens and provider API keys in the resolved profile-local `.env` under the selected state home, for example `/srv/estacoda-state/.estacoda/profiles/<profileId>/.env`, not only in shell exports.
- systemd user services may stop on logout unless linger is enabled, for example `sudo loginctl enable-linger $USER`.
- systemd service output is sent to the journal. Use `journalctl --user -u <unit> -f` for user services and `sudo journalctl -u <unit> -f` for system services.
- Source-mode installs hardcode the absolute workspace path. If the repo moves, uninstall and reinstall the service.
- `estacoda gateway start`, `estacoda gateway stop`, and `estacoda gateway restart` prefer a user-scope managed service when one exists. If both user and system services exist, the user service is controlled unless `--system` is passed. If only a system service exists, rerun with `--system`; EstaCoda will not silently control the system unit.
- Foreground/debug operation is `estacoda gateway run`. Persistent operation is `estacoda gateway install` followed by `estacoda gateway start`. Detached unmanaged background spawning is no longer the start path.

### Setup-Driven Gateway Activation

The setup prompt for installing and starting the gateway is titled `EstaCoda Gateway`.

It appears in two setup paths:

- During first-run onboarding when background memory finalization is enabled, including CLI-only setup with no channel.
- During the existing-user Setup Editor only when the first ready channel is newly configured.

In the existing-user Setup Editor it does not appear for non-channel changes or channel edits when a ready channel already existed. No setup path offers it when a managed gateway service is already installed or active. First-run onboarding may still offer launch after verification. Existing-user Setup Editor apply does not show the launch handoff after apply.

### Channel Commands

```bash
estacoda channels list              # Compact table of all channels
estacoda channels status telegram   # Detailed Telegram status
estacoda channels status discord    # Detailed Discord status
estacoda channels status email      # Detailed Email status
estacoda channels status whatsapp   # Detailed WhatsApp status
```

### Channel Enable / Disable

```bash
estacoda channels enable telegram    # Enable Telegram adapter
estacoda channels enable discord     # Enable Discord adapter
estacoda channels enable email       # Enable Email adapter
estacoda channels enable whatsapp    # Enable WhatsApp adapter

estacoda channels disable telegram   # Disable Telegram adapter
estacoda channels disable discord    # Disable Discord adapter
estacoda channels disable email      # Disable Email adapter
estacoda channels disable whatsapp   # Disable WhatsApp adapter
```

`enable` sets `enabled: true` in the selected profile `config.json` for the named channel. `disable` sets `enabled: false`.
Both commands are idempotent. Both preserve all other channel fields (tokens, allowlists, busy policy, queue depth).

Valid channel names: `telegram`, `discord`, `email`, `whatsapp` (case-insensitive).

Channel status shows:
- Enabled/disabled state
- Token/credential presence
- Allowlist configuration
- Surface pointers attached to the channel
- WhatsApp unofficial-API gate status (for WhatsApp)
- Email home/default address (for Email)

### WhatsApp Wizard

```bash
estacoda whatsapp
```

`estacoda whatsapp` is the standalone WhatsApp setup surface. The same shared WhatsApp QR setup flow is also used when a user selects WhatsApp from first-run onboarding optional capabilities or from the existing-user Setup Editor. Each surface warns that WhatsApp uses an unofficial Baileys-backed transport; checks the isolated `scripts/whatsapp-bridge/` npm package; asks before running bridge dependency repair; renders the QR code in the terminal; and writes profile config/session state only after QR pairing succeeds. Dependency decline/failure or QR timeout/failure leaves WhatsApp config unchanged. QR pairing times out after 120 seconds with `Pairing timed out - run estacoda whatsapp to try again.`

The wizard supports QR-only device pairing. It does not expose WhatsApp device pairing-code setup. If existing auth is logged out or missing, re-pair reset is explicit and limited to the selected profile's dedicated WhatsApp auth directory. If no allowed senders are entered, the wizard writes `dmPolicy: "pairing"` so the linked device is waiting for secure user authorization rather than open to arbitrary DMs.

## Cron Operator Commands

```bash
estacoda cron list                    # List all jobs
estacoda cron show <job-id>           # Job detail with recent executions
estacoda cron history [job-id]        # Execution history
estacoda cron run <job-id>            # Request a run
estacoda cron pause <job-id>          # Pause job
estacoda cron resume <job-id>         # Resume job
estacoda cron remove <job-id>         # Delete job
```

`cron list` shows: id, schedule, status, next run, prompt summary.

`cron show` shows: job config + last 5 executions with status and timestamps.

`cron history` shows: execution records with status, failure class/message where applicable.

`cron run` sets `runRequested=true` on the job. The next tick will execute it.

## Session Operator Commands

```bash
estacoda sessions list                                # Recent sessions with attached surfaces
estacoda sessions show <session-id>                   # Session detail + surface pointers
estacoda sessions current                             # Current runtime session
estacoda sessions attach <surface> <id> <session-id>  # Attach surface to session
estacoda sessions detach <surface> <id>               # Detach surface from session
estacoda sessions recall <query>                      # Summarize historical session matches
estacoda session recall <query>                       # Alias for sessions recall
estacoda sessions compact <session-id> [--topic <topic>] # Compact session history manually
```

Valid surfaces: `cli`, `telegram`, `discord`, `whatsapp`, `email`.

Sessions are **separate by default**. A CLI session and a channel session for the same user do not share context automatically. Explicit attach/detach is required.

`sessions recall` is bounded historical recall. It is profile-scoped, workspace-scoped when workspace metadata is available, and labeled as untrusted context. It uses auxiliary `session_search` summarization when configured and deterministic snippets as fallback.

`sessions compact` is semantic session compression. It compacts older history for the target session through the active runtime service. It does not rewrite durable Task state or run Memory File Compaction. The top-level CLI command is non-rotating in this implementation; it does not adopt a compacted child session.

## Channel Slash Commands

Available in Telegram gateway (and applicable Discord/WhatsApp where supported):

- `/status` — show current session and channel status
- `/sessions` — list recent sessions
- `/compact [topic]` — compact this in-session context through semantic session compression
- `/switch <session-id>` — switch to a different session
- `/attach <code>` — attach to a CLI session via handoff code
- `/detach` — detach from current session and create a new one
- `/new` — create a new session
- `/reset` — reset current session
- `/memory ...` — inspect and manage memory curation with the same behavior as CLI memory controls
- `/cron` — list cron jobs
- `/approvals` — show pending approvals
- `/stop` — abort the active turn for this chat; if no active turn, clear queued messages; if nothing is active or queued, request gateway stop

`/status` includes durable Task counts and may include bounded worker rows for currently running Attempts. It does not include worker prompts, raw transcripts, provider token streams, credentials, or tool arguments. `/stop` cancels the foreground turn; a Task returned by `delegate_task` has an independent durable lifecycle and is cancelled through Task controls.

## Session Steering and Compression

`/steer <note>` redirects the active foreground turn. It is separate from durable Task control. Bare `/compact [topic]` performs semantic compression for the current session; it does not rewrite Task history.

Gateway `/compact [topic]` preserves the parent transcript when compaction succeeds by creating a compacted child session and switching the channel pointer to that child. Interactive CLI `/compact [topic]` remains non-rotating until the CLI grows equivalent child-session adoption.

## Memory File Compaction

Memory File Compaction is not a top-level CLI command in this implementation. It is exposed as runtime tools:

- `memory.file_compact` — compact `USER.md` or `MEMORY.md`; supports dry-run.
- `memory.file_compaction_restore` — restore `USER.md` or `MEMORY.md` from a compaction backup.

Memory File Compaction uses the auxiliary `memory_compaction` route, scans generated output before writes, creates backups before applied writes, and never targets `SOUL.md` or `AGENTS.md`.

## Memory Curation Controls

Memory curation is exposed through shared operator commands. The same command implementation is used by top-level CLI commands, in-session slash commands, and authorized gateway surfaces such as Telegram.

```bash
estacoda memory mode [auto|review|manual]
estacoda memory recent [--limit N]
estacoda memory review [--limit N]
estacoda memory apply <record-id> [candidate-id|all]
estacoda memory reject <record-id> [candidate-id|all]
estacoda memory undo <record-id>
estacoda memory forget <USER.md|MEMORY.md> <exact text>
estacoda memory populate
estacoda memory edit
estacoda memory clear [USER.md|MEMORY.md|all] --yes
estacoda memory finalization list [--status pending|running|completed|failed] [--limit N]
estacoda memory finalization retry <job-id>
estacoda memory finalization prune [--keep N]
```

Inside active CLI sessions and Telegram sessions, use:

```text
/memory mode [auto|review|manual]
/memory recent [limit]
/memory review [limit]
/memory apply <record-id> [candidate-id|all]
/memory reject <record-id> [candidate-id|all]
/memory undo <record-id>
/memory forget <USER.md|MEMORY.md> <exact text>
/memory populate
/memory edit
/memory clear [USER.md|MEMORY.md|all] --yes
```

Default mode is `auto`, but auto-apply remains conservative: explicit, non-sensitive, low-risk, evidence-backed facts only. `review` records pending-review history without mutating memory. `manual` skips background checkpoints and leaves explicit manual commands available.

`memory populate` requires an active runtime session. If the top-level command cannot find one, run `/memory populate` inside an active CLI session or attached Telegram session.

`memory review` is an actionable queue over `memory-curation.json` when low-risk candidate operations are stored. `memory apply`, `memory undo`, and `memory forget` use the same mutation path as `memory.curate` and auto-curation.

Finalization queue administration is local-CLI-only. It exposes bounded profile-scoped metadata without transcript content. Failed jobs can be requeued with a fresh attempt budget, and terminal metadata is automatically bounded to the latest 1,000 rows per profile or pruned explicitly.

Telegram parity is intentional. `/memory ...` in Telegram should follow the same mode, policy, profile-local files, and curation history as the CLI, with only output formatting compacted for chat delivery.

## Task Cancellation and Approval Waits

Task cancellation is durable. The scheduler marks pending work cancelled, requests cancellation for active leased Attempts, and uses fencing so stale workers cannot settle newer work. Approval waits remain owned by the existing security and gateway approval systems; Task commands do not bypass or duplicate those controls.

## Busy Policy Configuration

When a user sends input while the agent is already processing a turn, the busy policy determines behavior:

| Policy | Behavior |
|--------|----------|
| `reject` (default) | Reply immediately with a busy message. |
| `queue` | Buffer the message and process it after the current turn completes. |
| `interrupt` | Abort the current turn and start a new one immediately. |

Configure per-channel in the selected profile `config.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "busyPolicy": "queue",
      "queueDepth": 5
    },
    "discord": {
      "enabled": true,
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

- `busyPolicy`: `"reject"` | `"queue"` | `"interrupt"`
- `queueDepth`: integer clamped to `[1, 10]`. Default: `3`. Only meaningful when `busyPolicy` is `"queue"`.
- Each channel configures its own policy independently. There is no top-level global busy policy setting.
- Omitted values normalize to `"reject"` and `3`.
- Invalid `busyPolicy` values fall back to `"reject"` with a runtime warning.
