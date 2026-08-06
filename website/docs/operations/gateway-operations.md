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

`gateway run --dry-run` checks adapter readiness, state directory writability, and gateway lock state without starting adapters or polling remote APIs. Use it to validate configuration before committing to a live process. `gateway run --once` performs one supervisor pass, including at most one eligible session-finalization job, and exits.

`gateway start` starts an installed service. It defaults to the selected profile's user-scope service. `gateway start --system` controls only the system service. If only a system service exists and `--system` is omitted, the command fails closed and tells the operator to rerun with `--system`.

`gateway install` is required before `gateway start`. `gateway start --background` is deprecated and no longer creates a detached unmanaged process; use service install/start for persistent operation.

## Setup activation prompt

The setup prompt that offers to install and start the gateway is titled `EstaCoda Gateway`.

The prompt appears:

- During first-run onboarding when background memory finalization is enabled, including CLI-only setup with no channel.
- During the existing-user Setup Editor when the first ready channel is newly configured.

In the existing-user Setup Editor, the prompt does not appear for non-channel changes or channel edits when a ready channel already existed. No setup path offers it when a managed gateway service is already installed or active.

First-run onboarding may still offer a post-apply launch prompt. Existing-user Setup Editor apply reports apply/verify state and exits the setup flow without a launch handoff. Use `EstaCoda Doctor` in the Setup Editor when you want read-only health checks and required fixes.

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
- The supervisor claims durable memory-finalization work only for its selected profile. One profile lease serializes checkpoints, `memory.curate`, automatic promotions, and operator memory writes.
- Graceful shutdown aborts active finalization work; its lease expires and the durable job becomes eligible for bounded retry by the next running gateway.

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
- Durable Task and cron host state
- All configured channels with ready/configured/disabled state
- Delivery router platforms
- Active surface pointers
- Pending approvals count
- Cron job summary and recent failures
- Memory-finalization queue counts: pending, running, retrying, and failed
- Recent delivery errors
- Missing config/env warnings
- Durable Task counts and bounded worker summaries when the active runtime exposes running Attempts

The managed gateway service also owns durable Task wakeups and restart recovery, even when no channel adapter is enabled. A Task bound to another workspace remains `waiting_for_host`; the service does not rewrite its workspace identity. Graceful shutdown drains active Task work with channel turns. Terminal completion delivery uses a profile-owned, session-authorized outbox. If the process stops while an external send is ambiguous, restart marks that delivery failed instead of sending a possible duplicate.

Session-finalization rows live in global `~/.estacoda/sessions.sqlite` with `profile_id` scope and an immutable message cutoff. They store no transcript copy and use the originating session workspace. If the managed service is stopped, queued work stays durable; it is not tied to the next interactive CLI launch. First-run setup can install the service for CLI-only use. Failed jobs can be inspected and retried with `estacoda memory finalization`; automatic retention keeps the latest 1,000 terminal rows per profile.

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

Durable delegated Tasks do not hold the creating turn open, so later messages follow the configured busy-session policy. Control commands still bypass it. `/stop` aborts the foreground turn but does not implicitly cancel a Task whose handle has already been returned. `/status` can report durable Task counts and bounded worker state for running Attempts.

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

## Telegram rapid-text batching

The gateway batches ordinary Telegram text from the same canonical account/chat/topic session and sender for `1500ms` by default. It joins fragments with blank lines and preserves their original message IDs in bounded runtime metadata. Limits default to `10` messages and `8000` characters; either threshold triggers an ingress-nonblocking flush.

Commands, callbacks, pairing/auth messages, attachments, and media groups bypass batching. Set `channels.telegram.textDebounceMs` to `0` to roll back to immediate dispatch. The setting does not change `getUpdates` polling cadence, media-group handling, or FIFO busy-queue ordering.

## Optional FIFO tail coalescing

Set `channels.<channel>.busyTextCoalescing.enabled` to `true` only with `busyPolicy: "queue"` to append eligible ordinary text to the final queued entry. Coalescing requires the same canonical session and sender and is bounded by `windowMs`, `maxMessages`, and `maxChars`. It preserves the entry's FIFO position plus component message IDs and receive timestamps. Commands, callbacks, approvals, attachments, media, and interrupt replacement bypass it. When a bound is reached, normal FIFO enqueue and queue-full behavior apply. Use `estacoda gateway status` or `estacoda channels status <channel>` to verify the enabled state.

## Durable busy queue

The canonical busy queue is FIFO in both modes. The default `memory` mode keeps queued turns only in the gateway process. Opt-in `sqlite` mode adds profile-scoped recovery:

```json
{
  "gateway": {
    "messageQueue": {
      "persistence": "sqlite",
      "maxPendingPerProfile": 1000,
      "uncertainRetentionDays": 7
    }
  }
}
```

SQLite mode has no silent memory fallback. An accepted busy message is persisted before the gateway sends `Queued (position N)`. The gateway claims the exact row before execution and completes it after a terminal result is handled. Queue clearing, interrupt replacement, and enabled FIFO-tail coalescing update SQLite before changing the in-memory FIFO.

### Recovery and delivery guarantees

On startup, the selected profile follows this recovery sequence:

1. Existing `claimed` rows become `uncertain`.
2. Only `pending` rows are considered for replay, in FIFO order.
3. Current channel authorization, workspace trust, account/chat/topic session scope, adapter availability, and attachment paths are checked again.
4. A pending row that fails any check becomes uncertain instead of executing.

This is not exactly-once execution. A crash before claim leaves a pending turn that can run after restart. A crash after claim may have happened before, during, or after external side effects, so automatic replay could duplicate a sent message, file change, command, or purchase. EstaCoda quarantines that row as uncertain. This also means durable mode does not guarantee at-least-once execution for uncertain work. There is no supported command to force-replay uncertain rows.

Graceful shutdown remains the primary path: it stops new ingress and waits for active and queued turns. If drain times out or the process crashes, an unfinished claimed turn is conservatively uncertain on the next durable startup. Pending turns that never began remain recoverable.

### Stored data and bounds

Durable rows are stored in the global `sessions.sqlite` database with a profile ID. A gateway loads only the selected profile; profiles do not share pending work. Each row includes:

- channel and platform message identifiers;
- canonical account/chat/topic session routing and sender identity;
- user message text and receive time;
- bounded metadata and attachment descriptors;
- queue status plus claim/completion/uncertainty timestamps.

The store does not add channel credentials, authorization headers, token-derived identifiers, remote attachment URLs, or attachment file bytes to a pending turn. Secret-shaped payloads are rejected, but ordinary user text and platform routing identifiers can still be sensitive. Attachment descriptors use canonical local paths beneath approved profile media/cache roots. The file must still exist inside an approved root during recovery; a missing, replaced, or escaping path makes the row uncertain.

The normalized limits are:

| Limit | Default | Hard bound |
|---|---:|---:|
| Non-completed rows per profile | `1000` | `1..10000` |
| Uncertain/completed retention | `7` days | `0..365` days |
| Persisted message JSON | — | `262144` bytes |
| Message text | — | `100000` characters |
| Attachments | — | `16` descriptors / `65536` JSON bytes |
| Message metadata | — | `32768` JSON bytes |

Pending, claimed, and uncertain rows count toward the profile capacity. Completed identities are kept only within the bounded deduplication/retention policy. Retention pruning runs at durable startup and periodically while the gateway runs.

### Inspect, clear, and roll back

From an authorized channel chat, `/status` includes profile-wide durable `pending`, `claimed`, and `uncertain` counts without displaying message content. `/stop` behaves by chat:

- if a turn is active, it cancels that turn and leaves queued rows intact;
- if no turn is active but that chat has queued rows, it clears the matching memory and SQLite rows transactionally;
- it does not clear another profile, chat, account, or topic, and it does not replay or clear uncertain rows.

To return to memory-only mode safely:

1. Prefer a graceful drain; inspect `/status` and clear unwanted per-chat queued work while SQLite mode is still active.
2. Set `gateway.messageQueue.persistence` to `"memory"` in the selected profile and restart the gateway.
3. Remember that switching modes does not delete existing SQLite rows. Memory mode ignores them. If SQLite is enabled again later, surviving pending rows are reconsidered under the normal recovery checks.

Do not edit `sessions.sqlite` directly while the gateway is running.

:::warning Security risk
SQLite mode intentionally persists remote user content and routing metadata beyond the gateway process lifetime. Protect the EstaCoda state directory and its backups as sensitive data, restrict local access, and enable durability only when recovery value outweighs the added retention and replay surface. Authorization and workspace trust are revalidated during recovery, but they do not protect a copied or locally exposed database.
:::

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
