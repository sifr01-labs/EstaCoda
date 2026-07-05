---
title: Gateway
description: Channel runtime, approvals, session routing, diagnostics, and operator control.
sidebar_position: 9
---

# Gateway

The gateway is the channel runtime. It binds remote adapters, routes sessions, enforces approvals, and exposes operator controls for one selected profile.

If you only use the CLI, you do not need the gateway. The moment you want Telegram, Discord, Email, or WhatsApp as a remote surface, the gateway becomes the boundary between the channel and the agent.

## What the gateway does

- Starts channel adapters (Telegram, Discord, Email, WhatsApp) according to the selected profile configuration.
- Authenticates and allowlists users per channel.
- Maps each chat to a session with a normalized session-key policy.
- Delivers progress, artifacts, and approvals through the channel's native transport.
- Maintains a durable pending-approval queue with a five-minute TTL.
- Routes operator slash commands (`/status`, `/approve`, `/model`, `/voice`, `/stop`, etc.) before they reach the agent.
- Rebuilds the runtime from a fresh config snapshot each turn so MCP and provider changes are visible without a full restart.
- Runs diagnostics and reports readiness per channel.

## Profile binding

The gateway runs against **one selected profile**. When you run it in the foreground or install it as a service, the selected profile is locked for the lifetime of that process or service unit.

```bash
estacoda gateway run
estacoda gateway run --profile work
```

Changing `active-profile.json` does not mutate a running gateway. If you need a gateway for a different profile, start a second instance or restart the existing one with the new profile.

Profile-local state includes:

| State | Location |
|-------|----------|
| Channel sessions, surface pointers, handoff codes | `~/.estacoda/profiles/<id>/gateway/` |
| Pending approvals (durable rows) | Global session DB, `pending_approvals` table, scoped by `profile_id` |
| Delivery logs | `~/.estacoda/profiles/<id>/logs/gateway.log` |
| Channel media downloads | `~/.estacoda/profiles/<id>/channel-media/` |
| WhatsApp auth data | `~/.estacoda/profiles/<id>/gateway/whatsapp-auth/` |

Service installs are also profile-bound. The generated service unit includes `gateway run --profile <id>`, and the unit name carries a profile-derived hash so multiple profiles can coexist.

```bash
estacoda gateway install --profile work
estacoda gateway start
estacoda gateway uninstall --profile work
```

## Setup-driven activation

When setup can install and start the gateway for a newly ready remote channel, the prompt title is `EstaCoda Gateway`.

The prompt appears during first-run onboarding when a ready channel is configured. It also appears in the existing-user Setup Editor when that run newly configures the first ready channel.

When the user chooses WhatsApp during onboarding or the Setup Editor, EstaCoda uses the same shared QR setup flow as `estacoda whatsapp`. It writes WhatsApp config/session state only after successful pairing; dependency decline/failure or QR timeout/failure leaves WhatsApp config unchanged.

The prompt does not appear for non-channel setup changes, for editing a channel after a ready channel already existed, or when a managed gateway service is already installed or active.

First-run onboarding may still offer a post-apply launch prompt. Existing-user Setup Editor apply does not show the launch handoff after apply. Use `EstaCoda Doctor` in the Setup Editor when you want read-only health checks and required fixes.

## Channel maturity

| Channel | v0.1.0 status |
|---------|---------------|
| Telegram | Live-proven first-party remote channel |
| Discord | Present, not live-proven |
| Email | Present, not live-proven |
| WhatsApp | Operational through an isolated bridge; gated behind `experimental: true` because the API is unofficial |

Telegram is the strongest first-party remote channel for v0.1.0. Discord and Email adapters compile, start, and pass automated checks, but live credential validation is deployment-specific. WhatsApp uses an unofficial library and requires an explicit unofficial-API gate; Meta may suspend accounts that use it.

Do not enable WhatsApp in a production profile without understanding the account-risk implications.

## Approvals

When a tool call requires explicit approval, the gateway creates a durable row in `pending_approvals`. The row includes the profile ID, session ID, command preview, tool name, status, expiry, and channel context.

The same queue can hold managed Python capability setup approvals. If a selected skill needs a missing required registered capability, the gateway can send a native channel approval prompt such as Telegram Install/Deny buttons. This approval is for a capability ID and selected groups, not an arbitrary shell command.

Approval invariants:

- Pending approvals are ask-only. Deterministic `deny` results and hard safety blocks never create rows.
- Profile A cannot list or resolve Profile B approvals.
- Session-scoped operations cannot resolve another session's approval.
- Expired or already-resolved approvals cannot be approved later.
- Approved, denied, and expired rows redact the raw command payload where practical.
- Managed Python setup approvals install only registered capability packages, invalidate the cached runtime for the session, and replay the original message after approval.

Remote `/approve` and `/deny`, inline buttons, and CLI operator resolution all route through the same `ChannelGateway` path. Adapters render the UI sugar; they do not authorize approvals or invalidate runtime caches.

```bash
estacoda gateway approvals
estacoda gateway approvals list --profile work
estacoda gateway approvals approve <id> [--session <session-id>] [--profile <profile-id>]
estacoda gateway approvals deny <id> [--session <session-id>] [--profile <profile-id>]
```

Approvals expire after five minutes. If an approval expires, the command must be reissued.

## Busy policies

When a new message arrives while the agent is already processing a turn, the channel's busy policy decides what happens:

| Policy | Behavior |
|--------|----------|
| `reject` (default) | Reply immediately with a busy message. |
| `queue` | Buffer the message and process it after the current turn completes. |
| `interrupt` | Abort the current turn and start the new one immediately. |

Configure per-channel in the selected profile `config.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "busyPolicy": "queue",
      "queueDepth": 5
    }
  }
}
```

`queueDepth` is clamped to `[1, 10]`. Invalid values fall back to `reject` with a runtime warning.

## Gateway slash and control commands

The gateway intercepts a set of control commands before they reach the agent loop. These are not a full command reference; they are the surface an operator uses to steer a remote session.

- **Session control**: `/status`, `/sessions`, `/switch`, `/attach`, `/detach`, `/new`, `/reset`
- **Model control**: `/model`, `/model clear`, `/model <provider>/<model>` — these bypass busy queues so you can change routes during an active turn
- **Voice control**: `/voice on`, `/voice all`, `/voice off`, `/voice status` (Discord also supports `/voice channel` and `/voice leave`)
- **Cron**: `/cron` to list jobs
- **Approvals**: `/approvals`, `/approve`, `/deny`, `/revoke`
- **Diagnostics**: `/diagnostics`, `/stop`

`/model --global` persists the chosen route as the profile primary model only when channel authorization, workspace trust, and profile config path proof all pass. It fails closed. `/model --global clear` is rejected.

When an active turn has running subagents, interrupt-mode busy policy queues ordinary inbound messages instead of aborting the parent turn. Control commands still bypass that queue. `/stop` cancels the active parent turn and active child work. `/approve`, `/deny`, `/status`, and model/control commands keep their existing bypass behavior. `/status` can include bounded active-subagent summaries without child prompts, raw transcripts, provider token streams, credentials, or tool arguments.

## Common failures and how to read them

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Gateway fails to start with missing token error | Environment variable referenced by `botTokenEnv` is absent. | Add the token to `~/.estacoda/profiles/<id>/.env` and restart. |
| Unauthorized user | Sender is not in the channel allowlist. | Update `allowedUserIds` (or equivalent) in profile config. |
| Wrong profile behavior | Gateway was started against a different profile than the one you are editing. | Check `estacoda gateway status`, stop, and restart with the intended profile. |
| Stale runtime cache | A config or model change was made while the gateway was running. | Runtime rebuilds from a fresh snapshot each turn; if something still looks stale, restart the gateway. |
| Approval expired | The operator did not respond within five minutes. | Re-run the original command. |
| Hard safety block | The security layer rejected the command deterministically. | Review the command against the active safety policy; hard blocks cannot be overridden by approval. |

## Diagnostics

```bash
estacoda gateway status      # Full status: channels, approvals, cron, service manager
estacoda gateway diagnose    # Per-channel readiness check; exits 1 on warnings
```

`gateway diagnose` checks token presence, host reachability, allowlist configuration, the WhatsApp unofficial-API gate, isolated WhatsApp bridge/package readiness, and cron directory permissions. Baileys and WhatsApp-specific Boom handling stay quarantined inside the bridge package; the root runtime does not depend on them directly.

## Service management (overview)

EstaCoda can install the gateway as a managed service:

- Linux systemd user services
- Linux systemd system services
- macOS launchd user LaunchAgents

```bash
estacoda gateway install
estacoda gateway start
estacoda gateway uninstall
```

`gateway start` starts the installed user-scope service. Use `gateway start --system` for an installed system service. For foreground/debug sessions, use `gateway run`, `gateway run --dry-run`, or `gateway run --once`.

Services inherit `HOME` but not your interactive shell environment. Keep secrets in the profile `.env` file. systemd user services may stop on logout unless linger is enabled:

```bash
sudo loginctl enable-linger $USER
```

For the full service runbook, see the gateway operations page.

## Related docs

- [Channels](./channels.md) — channel-specific configuration and maturity
- [Voice](./voice.md) — gateway auto-TTS and voice mode
- [Security and Approvals](./security-and-approvals.md) — approval policy and safety rules
- [CLI Commands](../reference/cli-commands.md) — full command reference
