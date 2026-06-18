---
title: Gateway Operations
description: Starting, stopping, diagnosing, and managing the gateway.
sidebar_position: 6
---

# Gateway Operations

The gateway is the channel runtime. It runs against one selected profile, serves remote adapters, routes approvals, and writes all state to that profile's local directory. Changing the active profile does not mutate a running gateway.

## Profile boundary

Every gateway process is bound to the profile selected at start time. The profile owns:

- Gateway config (`config.json`)
- Gateway state (`gateway/`)
- Gateway logs (`logs/gateway.log`)
- Channel tokens (`.env`)
- Session database (`sessions.sqlite`, global but profile-scoped by `profile_id`)

```bash
# Run foreground gateway for the current active profile
estacoda gateway run

# Run foreground gateway for a specific profile
estacoda gateway run --profile work
```

## Run and start

```bash
estacoda gateway run              # Foreground supervisor. Logs in terminal.
estacoda gateway run --dry-run    # Readiness check only. No lock, no PID, no adapters.
estacoda gateway run --once       # One supervisor pass, then exit.

estacoda gateway install          # Install user-scope service.
estacoda gateway start            # Start installed user-scope service.
estacoda gateway start --system   # Start installed system-scope service.
```

`gateway run` is the foreground/debug path. Use it when you want logs attached to the current terminal and no service manager in the loop.

`gateway run --dry-run` checks adapter readiness, state directory writability, and gateway lock state without starting adapters or polling remote APIs. Use it to validate configuration before committing to a live process. `gateway run --once` performs one supervisor pass and exits.

`gateway start` starts an installed service. It defaults to the selected profile's user-scope service. `gateway start --system` controls only the system service. If only a system service exists and `--system` is omitted, the command fails closed and tells the operator to rerun with `--system`.

`gateway install` is required before `gateway start`. `gateway start --background` is deprecated and no longer creates a detached unmanaged process; use service install/start for persistent operation.

## Setup activation prompt

The setup prompt that offers to install and start the gateway is titled `EstaCoda Gateway`.

The prompt appears:

- During first-run onboarding when a ready channel is configured.
- During the existing-user Setup Editor when the first ready channel is newly configured.

The prompt does not appear for non-channel setup changes, for channel edits when a ready channel already existed before that Setup Editor run, or when a managed gateway service is already installed or active.

First-run onboarding may still offer launch after verification. Existing-user Setup Editor apply reports apply/verification state and exits the setup flow without a launch handoff.

## Stop

```bash
estacoda gateway stop               # Graceful SIGTERM, wait up to 10s
estacoda gateway stop --force       # SIGKILL if graceful fails (unmanaged mode)
```

If a user-scope managed service exists, `stop` delegates to systemd or launchd. On systemd, `--force` still uses `systemctl stop`; it does not send SIGKILL directly. If no managed service exists, `stop` reads the PID file, sends SIGTERM, waits, then cleans up PID/state/lock files.

## Restart

```bash
estacoda gateway restart            # Restart installed user-scope service
estacoda gateway restart --graceful # Alias for restart in v0.1.0
estacoda gateway restart --system   # Restart system-scope service
```

`restart` delegates to the installed service using the same selection rules as `start`: user service by default, system service only with `--system`. If no managed service exists, it fails with installation guidance and does not create an unmanaged detached process. `restart --graceful` remains an alias for `restart`.

## Managed services

```bash
estacoda gateway install                    # Install user-scope systemd/launchd service
estacoda gateway install --profile work     # Install for profile "work"
estacoda gateway install --force            # Replace existing service unit
sudo estacoda gateway install --system --run-as-user estacoda  # System scope

estacoda gateway uninstall                  # Remove user-scope service
sudo estacoda gateway uninstall --system    # Remove system-scope service
```

Supported managers: Linux systemd (user and system), macOS launchd (user).

Each profile gets its own hash-suffixed unit or plist. Multiple profiles can have independent managed services.

Operational notes:

- Services use an explicit `HOME` but not your interactive shell environment.
- Put tokens and API keys in the profile `.env`, not only in shell exports.
- systemd user services may stop on logout unless linger is enabled: `sudo loginctl enable-linger $USER`.
- Service output goes to the journal. Use `journalctl --user -u <unit> -f` for user services.
- Source-mode installs hardcode the absolute workspace path. If the repo moves, uninstall and reinstall.
- Generated services invoke `gateway run --profile <id>`.
- `gateway start`, `gateway stop`, and `gateway restart` default to the installed user service. Use `--system` for an installed system service.

## Diagnostics

```bash
estacoda gateway diagnose         # Per-channel readiness check
estacoda gateway status           # Full gateway status
```

`gateway diagnose` checks:

- Telegram token presence, allowed users/chats
- Discord token presence
- Email IMAP/SMTP hosts, credentials, addresses
- WhatsApp unofficial-API gate, isolated bridge package/readiness, auth directory writability, device pairing, user authorization, `dmPolicy`, `groupPolicy`, `mode`, and queue pressure
- Cron directory permissions

Returns exit code 1 if any warnings exist.

`gateway status` surfaces:

- Service manager state
- Process state
- All configured channels with ready/configured/disabled state
- Delivery router platforms
- Active surface pointers
- Pending approvals count
- Cron job summary and recent failures
- Recent delivery errors
- Missing config/env warnings
- Bounded active-subagent summaries when the active runtime exposes delegated child work

## Channel enable and disable

```bash
estacoda channels enable telegram
estacoda channels disable telegram
```

Valid names: `telegram`, `discord`, `email`, `whatsapp` (case-insensitive).

`enable` sets `enabled: true` in profile config. `disable` sets `enabled: false`. Both are idempotent and preserve other fields.

## WhatsApp setup

```bash
estacoda whatsapp
```

WhatsApp setup uses one shared QR flow. It can be launched from first-run onboarding optional capabilities, the existing-user Setup Editor, or the standalone `estacoda whatsapp` command. Each surface warns about the unofficial Baileys-backed transport, keeps dependencies inside `scripts/whatsapp-bridge/`, checks bridge package readiness, asks before dependency repair, renders a QR code in the terminal, and writes config/session state only after QR pairing succeeds. Dependency decline/failure and QR timeout/failure leave WhatsApp config unchanged. WhatsApp pairing-code setup is not exposed.

If no allowed senders are entered, the wizard writes `dmPolicy: "pairing"` so the device is linked but waiting for secure user authorization. Logged-out state requires explicit re-pair/reset of only the selected profile's WhatsApp auth directory.

## Channel maturity

| Channel | Maturity | Note |
|---------|----------|------|
| Telegram | Live-proven | First-party remote channel for v0.1.0 |
| Discord | Present, not live-proven | Adapter exists; live validation incomplete |
| Email | Present, not live-proven | Adapter exists; attachments not supported |
| WhatsApp | Operational with external API risk | Gated behind `experimental: true`. Uses unofficial Baileys API. |

## Approval queue

Gateway approvals use a durable `pending_approvals` table in the session database. Rows are profile-scoped by `profile_id`. Pending approvals are ask-only: deterministic `deny` results and hardline blocks never become approvable queue rows.

Command payloads are transient and redacted after resolution. List and history surfaces use command preview/hash, not raw payload.

```bash
estacoda gateway approvals        # List pending approvals
estacoda gateway approvals approve <id>
estacoda gateway approvals deny <id>
```

## Busy policy

When a user sends input while the agent is already processing:

| Policy | Behavior |
|--------|----------|
| `reject` (default) | Reply immediately with a busy message |
| `queue` | Buffer and process after the current turn |
| `interrupt` | Abort the current turn and start a new one |

If the active turn has running subagents, ordinary messages are queued under `interrupt` instead of aborting the parent turn. Control commands still bypass: `/stop` aborts the parent turn and child work, `/approve` and `/deny` resolve approvals, `/status` can report bounded active-subagent state, and model/control commands keep their existing bypass behavior.

Configure per-channel in profile `config.json`:

```json
{
  "channels": {
    "telegram": {
      "busyPolicy": "queue",
      "queueDepth": 3
    }
  }
}
```

`queueDepth` is clamped to `[1, 10]`. Invalid values fall back to `reject` with a warning.

## Voice reply

Gateway voice reply mode is available when voice state manager and TTS config are present. Auto-TTS is text-first and fail-open. Generated auto-TTS media is ephemeral and profile-temp scoped.

```bash
/voice on|all|off|status
```

`/voice on` sets the chat to `voice_only`. `/voice all` (or `/voice tts`) enables TTS replies. `/voice off` disables auto-TTS. `/voice status` reports the current mode.

Voice state is stored in:

```text
~/.estacoda/profiles/<profile-id>/gateway/voice-mode.json
```

## Telegram pairing

Telegram uses bot-token-based pairing. The bot token must be present in the profile `.env` as `ESTACODA_TELEGRAM_BOT_TOKEN` (or the env var named in `botTokenEnv`). Allowed users and chats must be configured before the adapter accepts messages.

```bash
estacoda channels status telegram
```

## Telegram streaming

Telegram streaming is an experimental delivery option under `channels.telegram.streaming.enabled`. It defaults to enabled for configured Telegram channels. Set `channels.telegram.streaming.enabled` to `false` to opt out. When enabled, provider tokens edit Telegram messages during a turn, tool boundaries seal the current streamed message, tool progress appears below that sealed message, and later provider tokens start a new streamed message below the progress entry.

The stream is delivery-only. Final `response.text` remains authoritative, and session state, memory, tool execution, approvals, artifacts, and workflow state are unchanged. Partial edits use lightweight HTML escaping. The final edit or fallback delivery uses the normal Telegram formatter.

Operational constraints:

- Telegram streaming runs before normal final-text routing. If streaming cannot deliver the completed answer, `ChannelGateway` falls back to normal `DeliveryRouter` delivery.
- A turn abort signal is required.
- Provider fallback/failure cleanup, Telegram flood-control degradation, oversized partial payloads, approval/artifact ambiguity, cancellation, or final edit failure can force normal final text fallback.
- Active-turn degradation does not globally disable streaming for future turns.

Rollback is a config change:

```json
{
  "channels": {
    "telegram": {
      "streaming": {
        "enabled": false
      }
    }
  }
}
```

Restart or reload the gateway process bound to that profile after changing the setting.

## Logs

Gateway logs for the active profile:

```text
~/.estacoda/profiles/<profile-id>/logs/gateway.log
```

In foreground mode (`gateway run`), logs also appear in the terminal. In managed-service mode, logs go to the profile log file or the system journal.

## Failure modes

| Symptom | Likely cause | Repair |
|---------|-------------|--------|
| Gateway fails to start | Missing token or env var | Add token to profile `.env`, run `gateway diagnose` |
| Channel not ready | Unauthorized user or missing allowlist | Configure the channel allowlist (`allowedUsers`/`allowedGroups`; WhatsApp setup calls them allowed senders) |
| Wrong profile behavior | Gateway started against a different profile | Check `active-profile.json` or use `--profile` |
| Stale runtime cache | Old session data | Restart gateway or run `gateway restart` |
| Approval expiry | Pending approval timed out | Re-issue the command; approvals have a TTL |
| Hard safety block | Command matches hardline floor | Rephrase the command; hard blocks cannot be overridden |

## Gateway update mode

`estacoda update --gateway` is the non-interactive update path for managed gateway deployments.

- Logs to `~/.estacoda/logs/update.log`.
- After a successful managed-source update, attempts to restart the gateway service through the service-manager abstraction.
- If no managed service is detected, prints a manual restart instruction: `estacoda gateway restart`.
- Never restarts arbitrary user processes.

For full update internals, see [Update Operations](./update-operations.md).

## Gateway teardown during uninstall

`estacoda uninstall` tears down the gateway before removing install code or user data.

- Uses the service-manager abstraction (`estacoda gateway uninstall-service`).
- No raw `pkill`, `killall`, `systemctl`, or `launchctl` calls in the uninstall path.
- On Termux, system service removal is skipped; known wrapper paths are cleaned best-effort.
- Happens before code removal and before `--purge` data deletion.

## What is not documented here

- Full slash-command reference is not included here; see [Gateway](../user-guide/gateway.md) for user-facing gateway behavior.

## Related docs

- [Gateway](../user-guide/gateway.md) — user-facing gateway guide
- [Channels](../user-guide/channels.md) — channel configuration
- [Voice](../user-guide/voice.md) — voice behavior
- [Backups and State](./backups-and-state.md) — gateway state backup
