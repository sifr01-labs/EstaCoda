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
| `enabled` | `boolean` | `false` | Whether the adapter is started by `estacoda gateway start`. |
| `busyPolicy` | `"reject" \| "queue" \| "interrupt"` | `"reject"` | Behavior when a new message arrives during an active turn. |
| `queueDepth` | `number` | `3` | Maximum buffered messages when `busyPolicy` is `"queue"`. Clamped to `[1, 10]`. |

## Telegram

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botTokenEnv": "ESTACODA_TELEGRAM_TOKEN",
      "allowedUserIds": ["123456789"],
      "allowedChatIds": ["-1001234567890"],
      "groupSessionsPerUser": true,
      "threadSessionsPerUser": false,
      "sessionResetPolicy": "idle",
      "sessionIdleResetMinutes": 30,
      "pollTimeoutSeconds": 30,
      "maxAttachmentBytes": 10485760,
      "busyPolicy": "queue",
      "queueDepth": 5
    }
  }
}
```

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

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "experimental": true,
      "authDir": "~/.estacoda/profiles/<id>/gateway/whatsapp-auth",
      "allowedUsers": ["1234567890"],
      "pairingMode": "qr",
      "pairingCodePhoneNumber": "+1234567890",
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

**Important:** WhatsApp requires `experimental: true`. Without it, the adapter throws on start. See [Security](../security/handoff-preflight-report-v0.9.md) for unofficial-API risk.

## Defaults

If `busyPolicy` or `queueDepth` is omitted for a channel, the runtime uses:
- `busyPolicy`: `"reject"`
- `queueDepth`: `3`

There is no top-level `channels.busyPolicy` or `channels.queueDepth`. Each channel configures its own policy independently.
