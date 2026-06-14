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
| Experimental text streaming | `opt-in` |

**Behavior:**

- One evolving progress message per active turn
- Inline approval buttons map to `/approve` and `/deny`
- Final replies formatted in Telegram-safe HTML
- Optional streaming progressively edits Telegram messages during a turn; final `response.text` remains authoritative
- Activity labels localized (`en`, `ar`)
- Group sessions are per-user by default
- Thread sessions are shared by default
- Active chat → session mapping persists across gateway restarts

**Setup:**

```bash
estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_BOT_TOKEN --allow-user 123456789
estacoda channels enable telegram
estacoda gateway install
estacoda gateway start
```

Normal guided setup asks for:

- Telegram bot API token.
- Allowed Telegram user IDs.
- Allowed Telegram group chat IDs.

Normal guided setup does not ask for the bot-token env-var name. It stores the token under `ESTACODA_TELEGRAM_BOT_TOKEN`, and config points at it with `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"`. The bot token must not appear in config review or setup output.

Use `@BotFather` and `/newbot` to create a bot and copy the API token. Use `@userinfobot` and `/start` to get Telegram user IDs. For group chats, add the EstaCoda bot and either `@getidsbot` or `@chatIDrobot` to the group. The ID bot replies with the group chat ID; for groups, this is usually a long negative number.

**Readiness requirements:**

- `enabled: true`
- `botTokenEnv` set
- Referenced environment variable present

### Telegram Streaming (Experimental)

Telegram streaming is a delivery UX option. It does not change session truth, memory, tool execution, approvals, artifacts, or workflow state. The runtime still produces a final `response.text`, and that final text remains authoritative.

When `channels.telegram.streaming.enabled` is true, provider tokens progressively edit Telegram messages. Tool boundaries seal the current streamed message. Later provider tokens start a new streamed Telegram message below tool progress. Sealed streamed messages are never edited into the final answer.

The visible order is:

```text
streamed text -> tool progress -> streamed continuation -> final edit
```

Configure it under `channels.telegram.streaming`:

```json
{
  "channels": {
    "telegram": {
      "streaming": {
        "enabled": false,
        "editIntervalMs": 750,
        "minInitialChars": 24,
        "cursor": "▌",
        "maxFloodStrikes": 2,
        "cleanupFailedAttempts": true
      }
    }
  }
}
```

| Setting | Default | Behavior |
|---|---:|---|
| `channels.telegram.streaming.enabled` | `false` | Opt-in gate for Telegram streaming. |
| `channels.telegram.streaming.editIntervalMs` | `750` | Coalesces Telegram edits after the first streamed message. |
| `channels.telegram.streaming.minInitialChars` | `24` | Visible filtered character threshold before the first streamed message is sent. |
| `channels.telegram.streaming.cursor` | `"▌"` | Temporary cursor appended to live partial messages. |
| `channels.telegram.streaming.maxFloodStrikes` | `2` | Active-handle Telegram flood-control degradation limit. |
| `channels.telegram.streaming.cleanupFailedAttempts` | `true` | Deletes or neutralizes provisional streamed messages after failed or fallback provider attempts. |

Operational boundaries:

- Streaming runs only for Telegram delivery.
- `DeliveryRouter` disables streaming in v1.
- Streaming requires the gateway turn's abort signal.
- Partial stream edits use lightweight HTML escaping, not final Telegram formatting.
- Final delivery still uses normal Telegram formatting and chunking.
- Flood control or oversized partial payloads force fallback for the active turn only. Future Telegram streaming turns are not globally disabled.

Failure behavior and rollback:

- Provider fallback or failure cleanup deletes the current provisional streamed message when possible, or neutralizes it if deletion fails.
- Approval and artifact boundaries force normal final text fallback because the delivery order is ambiguous.
- Cancellation aborts the stream handle and removes the cursor when possible. Cleanup failure does not change the cancellation outcome.
- Duplicate final text is skipped only when final stream delivery succeeds and no approval or artifact boundary exists.
- To disable streaming, set `channels.telegram.streaming.enabled` to `false` and restart or reload the gateway process for that profile.

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
| DM text delivery | `experimental` |
| Group policy gating | `experimental` |
| Media download/upload | `experimental` |
| Message chunking | `experimental` |
| Final-only replies | `experimental` |
| Voice-bubble delivery | `ffmpeg` optional |

**Important:** WhatsApp uses `@whiskeysockets/baileys` through the isolated `scripts/whatsapp-bridge/` npm package. Baileys is an unofficial API; Meta may suspend WhatsApp accounts using unofficial libraries. Use at your own risk. The root runtime does not install or import Baileys or WhatsApp-specific `@hapi/boom` handling.

**Gaps:**

- No approvals.
- No visible progress delivery; WhatsApp receives final replies only, with best-effort typing presence during work.
- Live credential smoke is optional and manual.

**Setup:**

```bash
estacoda whatsapp
```

WhatsApp setup can run from first-run onboarding optional capabilities, the existing-user Setup Editor, or the standalone `estacoda whatsapp` command. All three surfaces use the same shared QR setup flow: they ask before repairing bridge dependencies, render a QR code in the terminal, and write profile config/session state only after successful QR pairing. Dependency decline/failure or QR timeout/failure records WhatsApp as skipped or incomplete in setup and leaves WhatsApp config unchanged. QR pairing times out after 120 seconds with `Pairing timed out - run estacoda whatsapp to try again.` WhatsApp device pairing-code setup is not exposed.

If no allowed senders are entered, setup writes `dmPolicy: "pairing"`. That is a waiting state for secure user authorization, not open access. WhatsApp authorization codes are single-use, expire after 10 minutes, and are stored only as salted SHA-256 hashes. Telegram pairing remains config-backed and unchanged.

`mode: "bot"` ignores `fromMe` messages. `mode: "self-chat"` accepts intentional self-chat input, prefixes bot replies with `replyPrefix`, and suppresses echoes. `groupPolicy` defaults to `"disabled"`; `"allowlist"` requires `allowedGroups`, and `"open"` must be configured explicitly.

Normal rapid WhatsApp text messages from the same chat/sender are debounced into one runtime turn after a short quiet window. Commands, authorization/pairing codes, approvals, denials, `/stop`, `/status`, and messages with media or other attachments bypass debounce and execute immediately.

Inbound image, video, normal audio, voice-note, and document messages are downloaded by the WhatsApp bridge into the selected profile's WhatsApp media cache, then exposed to the runtime as validated profile-local attachments. The cache lives under profile state, not in the workspace. Failed or oversized downloads surface as attachment failure metadata instead of dropping the whole text message.

Outbound media is validated in the main runtime before the bridge receives a local path. Voice-hinted incompatible audio requires `ffmpeg` for WhatsApp voice/PTT conversion; if conversion is unavailable, EstaCoda sends normal audio with a fallback caption.

**Readiness requirements:**

- `enabled: true`
- `experimental: true`
- QR-paired auth state
- `dmPolicy`/`groupPolicy` satisfied (`allowedUsers` or `allowedGroups` where required)

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

If the active turn has running subagents, ordinary messages queue under interrupt busy policy instead of aborting the parent turn. `/stop` still aborts the active parent turn and child work. `/approve`, `/deny`, `/status`, and model/control commands keep their control-command bypass behavior. `/status` can show bounded active-subagent summaries without exposing prompts, transcripts, raw provider token streams, credentials, or tool arguments.

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

**WhatsApp QR code not scanning:** Run `estacoda whatsapp` again. The QR code is rendered only in the terminal and expires after 120 seconds. If diagnostics report missing bridge dependencies, approve the explicit repair step or run `npm ci` inside `scripts/whatsapp-bridge/`; do not install Baileys in the root package.

---

## Related

- [Gateway](./gateway.md) — gateway setup and service management
- [Security and Approvals](./security-and-approvals.md) — approval behavior
- [Provider Reference](../reference/provider-reference.md) — provider maturity matrix
