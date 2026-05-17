---
title: "Channels"
description: "Channel architecture: gateway, adapters, session management, and multi-channel delivery."
---

# Channels

Channels are the surfaces through which users interact with EstaCoda. v0.9 supports four channels: Telegram, Discord, Email, and WhatsApp (experimental).

## Files

| File | Lines | Role |
|------|-------|------|
| `src/channels/channel-gateway.ts` | 1,408 | Generic adapter bridge |
| `src/channels/telegram-adapter.ts` | 847 | Telegram-specific adapter |
| `src/channels/discord-adapter.ts` | ~400 | Discord-specific adapter |
| `src/channels/email-adapter.ts` | ~350 | Email-specific adapter (IMAP/SMTP) |
| `src/channels/whatsapp-adapter.ts` | ~500 | WhatsApp-specific adapter (Baileys) |
| `src/channels/delivery-router.ts` | ~200 | Normalized delivery path |
| `src/channels/channel-session-store.ts` | ~240 | Persisted session mapping |
| `src/channels/channel-approval-store.ts` | ~180 | Approval persistence per channel |
| `src/channels/surface-pointer-store.ts` | ~120 | Cross-surface session pointers |
| `src/channels/handoff-store.ts` | ~150 | Short-lived handoff codes |
| `src/channels/telegram-format.ts` | ~200 | Telegram-safe HTML formatting |
| `src/channels/activity-labels.ts` | ~80 | Localized activity labels |

## ChannelGateway

Responsibilities:

- Auth / allowlist / pairing
- Session mapping with normalized session-key policy
- Session auto-reset policy
- Session-admin commands (`/sessions`, `/search`, `/switch`, `/attach`, `/detach`)
- Runtime construction from fresh config snapshot per turn
- Progress delivery
- Approval prompt delivery
- Command handling

## Telegram Adapter

**Live-proven capabilities:**

| Capability | Evidence |
|------------|----------|
| Text replies | `live-proven` |
| Document analysis | `live-proven` |
| Image understanding (Kimi) | `live-proven` |
| Image generation delivery | `live-proven` |
| Progress compaction | `smoke-tested` |
| Inline approvals | `smoke-tested` |
| Session persistence | `smoke-tested` |
| Attachment download | `smoke-tested` |
| Pairing codes | `smoke-tested` |
| Handoff codes | `smoke-tested` |

**UX choices:**

- One evolving progress message per active turn
- Inline approval buttons map to `/approve` and `/deny`
- Final replies formatted in Telegram-safe HTML
- Activity labels localized (`en`, `ar`)
- Group sessions per-user by default
- Thread sessions shared by default
- Active chat → session mapping persists across gateway restarts

**Setup:**

```bash
estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_TOKEN --allow-user 123456789
estacoda channels enable telegram
estacoda gateway start
```

## Discord Adapter

**Implemented capabilities:**

| Capability | Evidence |
|------------|----------|
| Text replies | `implemented but not live-proven` |
| DM support | `implemented but not live-proven` |
| Guild channel support | `implemented but not live-proven` |
| Thread support | `implemented but not live-proven` |
| Attachment download | `implemented but not live-proven` |
| Allowlists (users/guilds/channels) | `implemented but not live-proven` |
| Progress delivery | `implemented but not live-proven` |

**Limitations:**

- Slash commands are deferred to v0.9.1. Prefix-style text commands work.
- Live credential smoke is optional/manual.

**Setup:**

```bash
estacoda discord configure --bot-token-env ESTACODA_DISCORD_TOKEN --allow-user 123456789
estacoda channels enable discord
estacoda gateway start
```

## Email Adapter

**Implemented capabilities:**

| Capability | Evidence |
|------------|----------|
| IMAP receive | `implemented but not live-proven` |
| SMTP send | `implemented but not live-proven` |
| Reply-in-thread | `implemented but not live-proven` |
| Attachment ingestion | `implemented but not live-proven` |
| Allowed sender filtering | `implemented but not live-proven` |
| Home address | `implemented but not live-proven` |

**Behavior:**

- Polls IMAP inbox at configured interval.
- Maps email threads to sessions via `In-Reply-To` / `References` headers.
- New subject lines create new sessions.
- Replies are sent via SMTP with threading headers.
- Uses global security policy — no email-specific approval friction.
- `allowAllUsers: true` bypasses sender filtering.

**Setup:**

```bash
estacoda email configure \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --username bot@example.com \
  --password-env EMAIL_PASSWORD \
  --home-address operator@example.com
```

## WhatsApp Adapter (Experimental)

**Implemented capabilities:**

| Capability | Evidence |
|------------|----------|
| Baileys linked-device login | `experimental` |
| QR code login | `experimental` |
| Pairing-code login | `experimental` |
| DM text delivery | `experimental` |
| Media download/upload | `experimental` |
| Message chunking | `experimental` |

**Important:** WhatsApp support is **experimental** and gated behind `channels.whatsapp.experimental: true`. The adapter uses `@whiskeysockets/baileys`, which is an **unofficial API**. Meta may suspend WhatsApp accounts using unofficial libraries. Use at your own risk. See [Security](../security/handoff-preflight-report-v0.9.md) for risk details.

**Limitations:**

- DM-first; no group support.
- Live credential smoke is optional/manual.
- Baileys availability is checked at runtime; adapter fails gracefully if missing.

**Setup:**

```bash
estacoda whatsapp configure --allowed-user 1234567890
# Set channels.whatsapp.experimental: true in config
```

## DeliveryRouter

`DeliveryRouter` is the normalized delivery path for all channels.

**Targets:**

| Target | Syntax | Example |
|--------|--------|---------|
| Local file | `local` | `local` |
| Origin channel | `origin` | `origin` |
| Silent | `silent` | `silent` |
| Telegram | `telegram:<chatId>` | `telegram:123456789` |
| Discord | `discord:<channelId>` | `discord:123456789` |
| WhatsApp | `whatsapp:<number>` | `whatsapp:1234567890` |
| Email | `email:<address>` | `email:operator@example.com` |

**Behavior:**

- Multi-target: one message can be delivered to multiple targets.
- Truncation: long text is truncated with ellipsis when channel limits apply.
- Error persistence: delivery failures are recorded and visible via `estacoda gateway status`.
- Progress/artifact variants: `deliverProgress`, `deliverArtifact`.

## Session Identity Policy

Channel session identity includes explicit chat/thread policy:

| Context | Default |
|---------|---------|
| DM | Per-user |
| Group | Per-user |
| Thread | Shared |

Configurable via runtime config.

## Cross-Surface Sessions

Sessions are **separate by default**. A CLI session and a channel session for the same user do not share context automatically.

Explicit attach/detach is required:
- `estacoda sessions attach <surface> <surface-id> <session-id>`
- `estacoda sessions detach <surface> <surface-id>`
- `/attach <code>` in Telegram (redeems a handoff code)
- `/detach` in Telegram (creates a new independent session)

Surface pointers are stored in `FileSurfacePointerStore` under the bound profile gateway state.

## Busy Policy

Each channel independently configures how incoming messages are handled when the agent is already processing a turn:

- `reject` — reply with a busy message (default)
- `queue` — buffer messages, process sequentially after the current turn
- `interrupt` — abort the current turn and start the new one immediately

See [Channel Configuration](../operations/channel-configuration.md) for config schema and examples.

## Gateway Runtime

Gateway processes are bound to the profile selected at gateway start time. Changing `active-profile.json` does not mutate an already-running gateway. Runtime state is profile-local:

- channel approvals, channel sessions, surface pointers, and handoff codes live under the bound profile `gateway/` state
- delivery logs live under the bound profile log state
- channel media and WhatsApp auth state live under the bound profile state paths
- gateway process registry entries are profile-tagged

Gateway turns rebuild runtimes from fresh selected-profile config snapshots. This helps MCP reload semantics, but the supervisor remains bound to the profile chosen at start.

```bash
# Enable channels before starting
estacoda channels enable telegram
estacoda channels enable discord

# Start gateway
estacoda gateway start
estacoda gateway start --profile work

# Check status
estacoda gateway status
estacoda gateway diagnose

# List channels
estacoda channels list
estacoda channels status telegram
```

## Operator Commands

Channel-specific commands available in gateway:

- `/status` — show current session and channel status
- `/sessions` — list recent sessions
- `/switch <session-id>` — switch to a different session
- `/attach <code>` — attach to a CLI session via handoff code
- `/detach` — detach from current session and create a new one
- `/new` — create a new session
- `/reset` — reset current session
- `/cron` — list cron jobs
- `/approvals` — show pending approvals
- `/stop` — abort the active turn for this chat; if no active turn, clear queued messages; if nothing is active or queued, request gateway stop

## Limitations

- Telegram is the only live-proven channel.
- Discord slash commands are deferred to v0.9.1.
- WhatsApp is experimental and uses an unofficial API with account-risk implications.
- Email live smoke is optional/manual.
- Gateway status reports readiness, not background-process liveness.
- Channel-specific safety rules are partial — general safety policy applies to all channels equally.
- Gateway approval queue hardening and richer inline button flows are planned for Part 2; do not treat them as complete beyond the currently implemented channel approval prompts.
