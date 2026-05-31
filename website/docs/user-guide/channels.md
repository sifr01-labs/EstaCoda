---
title: Channels
description: Channel configuration, maturity, and operational boundaries for v0.1.0.
sidebar_position: 10
---

# Channels

Channels are the surfaces through which users interact with EstaCoda. The CLI is the direct surface. The gateway adds remote channels: Telegram, Discord, Email, and WhatsApp. Each channel has a maturity label, a set of implemented capabilities, and a list of known gaps.

Do not assume a channel is release-proven because it is documented. Check the maturity label.

---

## Channel Maturity Summary

| Channel | Maturity | Inbound | Outbound | Attachments | Threads | Approvals | Progress |
|---|---|---|---|---|---|---|---|
| **CLI** | `live-proven` | direct | direct | N/A | N/A | interactive | N/A |
| **Telegram** | `live-proven` | polling | push | yes | yes | yes | yes |
| **Discord** | `present-not-live-proven` | websocket | push | no | no | yes | no |
| **Email** | `present-not-live-proven` | polling | push | no | yes | no | no |
| **WhatsApp** | `experimental` | websocket | push | no | no | no | no |

**Definitions:**

- `live-proven` — validated in realistic usage.
- `present-not-live-proven` — code exists, adapters initialize, and local smoke tests pass. Live end-to-end validation has not been completed for v0.1.0.
- `experimental` — gated behind `experimental: true`. Unofficial API. Account risk.

---

## CLI

The CLI is the direct interaction surface. It is not a gateway channel, but it is the reference behavior against which all gateway channels are measured.

- Interactive sessions with real-time tool execution
- Approval prompts rendered in-terminal
- Session attach/detach via `estacoda sessions` commands
- Gateway control via `estacoda gateway` commands
- Operator diagnostics via `estacoda gateway diagnose`

The CLI does not use the DeliveryRouter. It writes directly to stdout and reads from stdin.

---

## Telegram

Telegram is the live-proven first-party remote channel for v0.1.0.

**Capabilities:**

| Capability | Status |
|---|---|
| Text replies | `live-proven` |
| Document analysis | `live-proven` |
| Image understanding | `live-proven` |
| Image generation delivery | `live-proven` |
| Inline approvals | `implemented` |
| Session persistence | `implemented` |
| Attachment download | `implemented` |
| Pairing codes | `implemented` |
| Handoff codes | `implemented` |
| Progress compaction | `implemented` |

**Behavior:**

- One evolving progress message per active turn
- Inline approval buttons map to `/approve` and `/deny`
- Final replies formatted in Telegram-safe HTML
- Activity labels localized (`en`, `ar`)
- Group sessions are per-user by default
- Thread sessions are shared by default
- Active chat → session mapping persists across gateway restarts

**Setup:**

```bash
estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_TOKEN --allow-user 123456789
estacoda channels enable telegram
estacoda gateway install
estacoda gateway start
```

**Readiness requirements:**

- `enabled: true`
- `botTokenEnv` set
- Referenced environment variable present

---

## Discord

Discord is present in code but not live-proven for v0.1.0.

**Capabilities:**

| Capability | Status |
|---|---|
| Text replies | `present-not-live-proven` |
| DM support | `present-not-live-proven` |
| Guild channel support | `present-not-live-proven` |
| Thread support | `present-not-live-proven` |
| Attachment download | `present-not-live-proven` |
| Allowlists (users/guilds/channels) | `present-not-live-proven` |
| Inline approval buttons | `implemented` |

**Gaps:**

- Discord attachments, threads, and progress streaming are not supported by the capability registry.
- Slash commands are deferred post-v0.1.0.
- Live credential smoke is optional and manual.

**Voice channels:** Optional Discord voice-channel support exists only when `channels.discord.voiceChannel.enabled` is true and the optional Discord voice stack is installed. Missing packages or permissions return setup errors before joining.

**Setup:**

```bash
estacoda discord configure --bot-token-env ESTACODA_DISCORD_TOKEN --allow-user 123456789
estacoda channels enable discord
estacoda gateway install
estacoda gateway start
```

**Readiness requirements:**

- `enabled: true`
- `botTokenEnv` set

---

## Email

Email is present in code but not live-proven for v0.1.0.

**Capabilities:**

| Capability | Status |
|---|---|
| IMAP receive | `present-not-live-proven` |
| SMTP send | `present-not-live-proven` |
| Reply-in-thread | `present-not-live-proven` |
| Attachment ingestion | `present-not-live-proven` |
| Allowed sender filtering | `present-not-live-proven` |
| Home address | `present-not-live-proven` |

**Gaps:**

- Email attachments are not supported by the capability registry.
- No email-specific approval friction; uses global security policy.
- Live credential smoke is optional and manual.

**Behavior:**

- Polls IMAP inbox at configured interval
- Maps email threads to sessions via `In-Reply-To` / `References` headers
- New subject lines create new sessions
- Replies sent via SMTP with threading headers
- `allowAllUsers: true` bypasses sender filtering

**Setup:**

```bash
estacoda email configure \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --username bot@example.com \
  --password-env EMAIL_PASSWORD \
  --home-address operator@example.com
```

**Readiness requirements:**

- `enabled: true`
- `imapHost`, `smtpHost`, `username`, `passwordEnv`, `ownAddress` all set

---

## WhatsApp (Experimental)

WhatsApp is experimental and gated behind `channels.whatsapp.experimental: true`.

**Capabilities:**

| Capability | Status |
|---|---|
| Baileys linked-device login | `experimental` |
| QR code login | `experimental` |
| Pairing-code login | `experimental` |
| DM text delivery | `experimental` |
| Media download/upload | `experimental` |
| Message chunking | `experimental` |

**Important:** The adapter uses `@whiskeysockets/baileys`, which is an unofficial API. Meta may suspend WhatsApp accounts using unofficial libraries. Use at your own risk.

**Gaps:**

- DM-only. No group support.
- No approvals.
- No progress delivery.
- Live credential smoke is optional and manual.

**Setup:**

```bash
estacoda whatsapp configure --allowed-user 1234567890
```

Then set `channels.whatsapp.experimental: true` in config.

**Readiness requirements:**

- `enabled: true`
- `experimental: true`

---

## Busy Policy

Each channel configures how incoming messages are handled when the agent is already processing a turn:

- `reject` — reply with a busy message (default)
- `queue` — buffer messages, process sequentially after the current turn
- `interrupt` — abort the current turn and start the new one immediately

Queue depth is clamped to `[1, 10]`, default `3`. Configure independently per channel.

---

## Cross-Surface Sessions

Sessions are separate by default. A CLI session and a Telegram session for the same user do not share context automatically.

Explicit attach/detach is required:

```bash
# CLI side
estacoda sessions attach telegram <chat-id> <session-id>
estacoda sessions detach telegram <chat-id>
```

```text
# Telegram side
/attach <handoff-code>
/detach
```

Surface pointers are stored in the bound profile's gateway state.

---

## Gateway Commands

All gateway channels support a common set of control commands:

| Command | Purpose |
|---|---|
| `/help` | Show available commands |
| `/status` | Show current session and channel status |
| `/sessions` | List recent sessions |
| `/switch <session-id>` | Switch to a different session |
| `/attach <code>` | Attach to a CLI session via handoff code |
| `/detach` | Detach and create a new session |
| `/new` | Create a new session |
| `/reset` | Reset current session |
| `/model` | Show ready model choices |
| `/model <provider>/<model>` | Set conversation-scoped model override |
| `/model clear` | Clear conversation-scoped override |
| `/approve [once|session|always]` | Resolve pending approval |
| `/deny` | Deny pending approval |
| `/approvals` | Show pending approvals |
| `/revoke <id>` | Revoke a persistent approval |
| `/stop` | Abort active turn or clear queue |
| `/voice on|all|off|status` | Control voice reply mode |
| `/cron` | List cron jobs |
| `/diagnostics` | Run gateway diagnostics |

Model control commands bypass busy-session queues so the operator can change model state while a conversation is active.

---

## DeliveryRouter

`DeliveryRouter` is the normalized delivery path for all channels. It handles:

- Multi-target delivery (one message to multiple channels)
- Text truncation with ellipsis when channel limits apply
- Error persistence (delivery failures recorded in gateway status)
- Artifact delivery (images, audio, documents)
- Voice-hinted audio artifact routing

Delivery targets use the syntax:

```text
telegram:<chatId>
discord:<channelId>
whatsapp:<number>
email:<address>
local
origin
silent
```

---

## Failure Modes

**Channel adapter fails to start:** Check `estacoda gateway diagnose`. The diagnostics command reports readiness per adapter, not background-process liveness.

**Telegram bot not responding:** Verify `botTokenEnv` is set, the variable is present in the profile `.env`, and `estacoda channels enable telegram` was run.

**Discord bot not connecting:** Verify token, intents, and guild permissions. Check gateway logs for connection errors.

**Email not polling:** Verify IMAP host, SMTP host, username, and password. Check that the password env var is exported.

**WhatsApp QR code not scanning:** Baileys availability is checked at runtime. If the adapter fails gracefully, install `@whiskeysockets/baileys` in the operator environment.

---

## Related

- [Gateway](./gateway.md) — gateway setup and service management
- [Security and Approvals](./security-and-approvals.md) — approval behavior
- [Provider Reference](../reference/provider-reference.md) — provider maturity matrix
