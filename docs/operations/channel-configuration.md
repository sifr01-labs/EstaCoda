---
title: "Channel Configuration"
description: "Config schema, fields, and examples for all four channels."
---

# Channel Configuration

Channel configuration lives in the selected profile config: `~/.estacoda/profiles/<id>/config.json`. All four channels share a common base structure with adapter-specific fields.

## Common Fields

Every channel object supports:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Whether the adapter is loaded by `estacoda gateway run` or by an installed service started with `estacoda gateway start`. |
| `busyPolicy` | `"reject" \| "queue" \| "interrupt"` | `"reject"` | Behavior when a new message arrives during an active turn. |
| `queueDepth` | `number` | `3` | Maximum buffered messages when `busyPolicy` is `"queue"`. Clamped to `[1, 10]`. |

## Telegram

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botTokenEnv": "ESTACODA_TELEGRAM_BOT_TOKEN",
      "allowedUserIds": ["123456789"],
      "allowedChatIds": ["-1001234567890"],
      "groupSessionsPerUser": true,
      "threadSessionsPerUser": false,
      "sessionResetPolicy": "idle",
      "sessionIdleResetMinutes": 30,
      "pollTimeoutSeconds": 30,
      "maxAttachmentBytes": 10485760,
      "streaming": {
        "enabled": false,
        "editIntervalMs": 750,
        "minInitialChars": 24,
        "cursor": "▌",
        "maxFloodStrikes": 2,
        "cleanupFailedAttempts": true,
        "transport": "auto",
        "freshFinalAfterSeconds": 0
      },
      "busyPolicy": "queue",
      "queueDepth": 5
    }
  }
}
```

Guided setup asks for:

- Telegram bot API token.
- Allowed Telegram user IDs.
- Allowed Telegram group chat IDs.

Guided setup does not ask for the bot-token env-var name. The token is written to the selected profile `.env` as `ESTACODA_TELEGRAM_BOT_TOKEN`, and the profile config uses `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"`. Config review and setup output must redact the raw token.

Use `@BotFather` and `/newbot` to get the bot API token. Use `@userinfobot` and `/start` to get Telegram user IDs. For group chats, add the EstaCoda bot and either `@getidsbot` or `@chatIDrobot` to the group; the ID bot replies with the group chat ID, usually a long negative number.

### Telegram Streaming

Telegram streaming is an experimental delivery option under `channels.telegram.streaming`. It defaults to enabled for configured Telegram channels. Provider tokens progressively edit Telegram messages during a turn, while `response.text` remains the authoritative final answer recorded by the runtime. Streaming does not change session truth, memory, tool execution, approvals, artifacts, or workflow state. To opt out, set `channels.telegram.streaming.enabled` to `false`.

The ordering model is:

```text
streamed text -> tool progress -> streamed continuation -> final edit
```

Tool boundaries seal the current streamed Telegram message. Later provider tokens start a new streamed Telegram message below the tool-progress message. Sealed streamed messages are never edited into the final answer. If streaming fails, degrades, or becomes ambiguous, the gateway falls back to normal final text delivery.

| Setting | Default | Description |
|---------|---------|-------------|
| `channels.telegram.streaming.enabled` | `true` | Enables Telegram streaming for configured Telegram channels. Set to `false` to opt out. |
| `channels.telegram.streaming.editIntervalMs` | `750` | Coalescing interval for Telegram edits after the first streamed message. |
| `channels.telegram.streaming.minInitialChars` | `24` | Visible filtered character threshold before the first streamed message is sent. |
| `channels.telegram.streaming.cursor` | `"▌"` | Temporary cursor appended to live partial messages and removed on finalize, abort, or segment seal. |
| `channels.telegram.streaming.maxFloodStrikes` | `2` | Active-handle Telegram flood-control degradation limit. Reaching the limit forces final fallback for that turn. |
| `channels.telegram.streaming.cleanupFailedAttempts` | `true` | Whether failed or fallback provider attempts delete or neutralize provisional streamed messages before final fallback. |
| `channels.telegram.streaming.transport` | `"auto"` | Streaming transport. `"auto"` selects draft previews for DMs when supported and edit streaming otherwise. `"edit"` uses ordinary message edits. `"draft"` uses Telegram draft previews in DMs only when supported by the Bot API. |
| `channels.telegram.streaming.freshFinalAfterSeconds` | `0` | Fresh-final delay in seconds. `0` disables fresh-final delivery. A positive value sends the completed answer as a fresh message after a preview has been visible that many seconds, then deletes the preview best-effort. |

Operational constraints:

- Streaming runs only for Telegram delivery.
- Telegram streaming runs before normal final-text routing. If streaming cannot deliver the completed answer, `ChannelGateway` falls back to normal `DeliveryRouter` delivery.
- Streaming requires the gateway turn's abort signal.
- Partial stream edits use lightweight HTML escaping, not final Telegram formatting.
- Final delivery still uses normal authoritative Telegram formatting and chunking.
- Draft previews and rich message delivery depend on Telegram and Bot API support. Rich delivery is opportunistic and falls back to normal Telegram formatting when unsupported, too long, or ambiguous.
- Telegram flood control or oversized escaped partial payloads degrade only the active stream handle and require final fallback. Future turns are not globally disabled.

Failure and rollback behavior:

- Provider failure or provider fallback marks the active stream handle as fallback-required. The adapter deletes the current provisional streamed message when possible, or neutralizes it if deletion fails.
- Approval or artifact boundaries are treated as ambiguous at the gateway, so the final text is delivered normally even if streaming had partial output.
- Cancellation aborts the live stream handle and removes the cursor when possible. Cleanup failures are secondary to the original cancellation outcome.
- Duplicate final text is skipped only when final stream delivery succeeds and no approval or artifact boundary exists.
- To roll back, set `channels.telegram.streaming.enabled` to `false` and restart or reload the gateway process that owns the profile.

## Discord

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "botTokenEnv": "ESTACODA_DISCORD_TOKEN",
      "allowedUsers": ["123456789"],
      "allowedGuilds": ["123456789"],
      "allowedChannels": ["123456789"],
      "freeResponseChannels": ["123456789"],
      "voiceChannel": {
        "enabled": false,
        "autoJoinOnCommand": true
      },
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

`channels.discord.voiceChannel.enabled` defaults to `false`. When enabled, EstaCoda requests `GatewayIntentBits.GuildVoiceStates` and `/voice channel` can delegate to Discord voice capability methods. `autoJoinOnCommand` defaults to `true`. The bot must have `Connect`, `Speak`, and `UseVAD` permissions before joining; missing optional voice dependencies or permissions return structured setup errors.

See [Voice Operations](./voice.md) for optional package and troubleshooting details.

## Email

```json
{
  "channels": {
    "email": {
      "enabled": true,
      "imapHost": "imap.example.com",
      "imapPort": 993,
      "smtpHost": "smtp.example.com",
      "smtpPort": 587,
      "username": "bot@example.com",
      "passwordEnv": "EMAIL_PASSWORD",
      "ownAddress": "bot@example.com",
      "homeAddress": "operator@example.com",
      "allowedSenders": ["operator@example.com"],
      "allowAllUsers": false,
      "pollIntervalSeconds": 30,
      "maxAttachmentBytes": 10485760,
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

## WhatsApp

Use the single setup wizard:

```bash
estacoda whatsapp
```

The wizard uses QR-only device pairing and renders the QR code in the terminal. It checks the isolated bridge package under `scripts/whatsapp-bridge/`; if dependencies are missing, it asks before running the repair/install step. It does not silently install dependencies or write WhatsApp config until QR pairing succeeds.

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "experimental": true,
      "authDir": "~/.estacoda/profiles/<id>/gateway/whatsapp-auth",
      "mode": "bot",
      "dmPolicy": "allowlist",
      "groupPolicy": "disabled",
      "allowedUsers": ["1234567890"],
      "allowedGroups": [],
      "replyPrefix": "EstaCoda: ",
      "pairingMode": "qr",
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

If no allowed WhatsApp users are added during setup, `dmPolicy` is set to `"pairing"`. That means the device can be QR-paired, but the channel is not reported as fully ready and messages are not open to arbitrary users. User authorization codes are separate from device QR pairing: codes are displayed once by operator flows, expire after 10 minutes, are single-use, and are persisted only as salted SHA-256 hashes in profile-local state.

WhatsApp DM policies are explicit: `"disabled"` rejects direct messages, `"allowlist"` accepts canonical `allowedUsers`, `"pairing"` only allows authorization-code redemption plus denial handling, and `"open"` accepts all DMs only when configured. Group policy fails closed by default: `"disabled"` ignores groups, `"allowlist"` accepts canonical `allowedGroups`, and `"open"` accepts all groups only when configured.

WhatsApp allowlists use canonical identities. Phone numbers and `@s.whatsapp.net` JIDs normalize to digits, `@lid` IDs normalize case-insensitively, and group IDs normalize as `@g.us` JIDs. LID/phone aliases are stored profile-locally without message content.

Use `mode: "self-chat"` only when the linked account is intentionally used as the operator chat. In self-chat mode EstaCoda prefixes replies with `replyPrefix` and suppresses echoes by recent sent message ID or prefix; in `mode: "bot"`, `fromMe` messages are ignored and no reply prefix is applied.

WhatsApp does not stream visible progress. Tool/provider progress is best-effort typing presence only, and users receive the final reply after the turn finishes. Final text is adapted to WhatsApp formatting and chunked by the adapter. Telegram remains richer for live progress and inline action UX; WhatsApp supports final text, quoted first replies where possible, and media delivery through the isolated bridge.

Rapid normal WhatsApp text messages are debounced at the gateway before runtime execution. Defaults are `textDebounceMs: 5000`, `textDebounceMaxMessages: 10`, and `textDebounceMaxChars: 8000`; set `textDebounceMs: 0` to disable the quiet window. Debounce applies only to normal WhatsApp text turns after authorization and group mention routing. Slash commands, `/stop`, `/status`, `/approve`, `/deny`, authorization-code redemption, and messages with media or other attachments bypass debounce and execute immediately.

WhatsApp media delivery accepts only main-runtime validated local paths. The trusted workspace root and profile-local channel media/temp roots are allowed; arbitrary system paths are rejected before the bridge sees them. Explicitly allowed remote media URLs are downloaded into the profile-local channel media cache first and still obey upload size limits. Text-like inbound document previews are bounded before prompt assembly; binary documents and oversized media surface as structured attachment status rather than injected content.

For WhatsApp voice bubbles, install `ffmpeg` in the operator environment. Voice-hinted audio that is already OGG/Opus is sent as voice/PTT. Incompatible provider audio converts to OGG/Opus in the main runtime under profile-local temp/media roots; if `ffmpeg` is unavailable or conversion fails, EstaCoda falls back to normal audio delivery with a clear fallback caption.

**Important:** WhatsApp requires `experimental: true`. The transport uses the unofficial Baileys API through the isolated bridge package, so account suspension risk remains. See [Security](../subsystems/security.md#channel-security) for the channel authorization and unofficial-API boundaries.

## Defaults

If `busyPolicy` or `queueDepth` is omitted for a channel, the runtime uses:
- `busyPolicy`: `"reject"`
- `queueDepth`: `3`

There is no top-level `channels.busyPolicy` or `channels.queueDepth`. Each channel configures its own policy independently.
