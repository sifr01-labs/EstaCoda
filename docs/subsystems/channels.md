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
| `src/channels/voice-transcription.ts` | ~280 | Gateway voice attachment transcript injection and STT preprocessing handoff |
| `src/gateway/voice-state.ts` | ~160 | Profile-local per-chat voice mode and duplicate transcript state |
| `src/channels/discord-voice-bridge.ts` | ~430 | Optional Discord voice-channel join/listen/speak/leave bridge |
| `src/channels/channel-session-store.ts` | ~240 | Persisted session mapping |
| `src/channels/channel-approval-store.ts` | ~180 | Approval persistence per channel |
| `src/gateway/approval-queue.ts` | ~320 | Durable pending gateway approvals |
| `src/channels/surface-pointer-store.ts` | ~120 | Cross-surface session pointers |
| `src/channels/handoff-store.ts` | ~150 | Short-lived handoff codes |
| `src/channels/approval-actions.ts` | ~80 | Generic inline approval action values |
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
- Durable pending approval row creation and resolution
- Inline approval action parsing/routing
- Persistent grant handling and runtime-cache invalidation
- Command handling

`ChannelGateway` is the approval orchestrator. It owns auth, chat/session scope, busy/drain behavior, remote `/approve` and `/deny`, inline approval routing, durable queue resolution, continuation resume/termination, persistent grant handling, and runtime-cache invalidation.

Adapters only render or normalize channel-specific transport events. They must not mutate `GatewayApprovalQueue`, authorize approvals, persist grants, or call `RuntimeCache.invalidate(...)`.

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
| Inline approval buttons | `smoke-tested` |

**Limitations:**

- Slash commands are deferred to v0.9.1. Prefix-style text commands and tested button interactions work.
- Live credential smoke is optional/manual.

**Voice channels:** Optional Discord voice-channel support is available only when `channels.discord.voiceChannel.enabled` is true and the optional Discord voice stack is installed in the operator environment. `ChannelGateway`, not the adapter, owns `/voice channel` and `/voice leave` parsing and delegates to adapter capability methods. Missing optional packages, `GuildVoiceStates` intent, or `Connect`/`Speak`/`UseVAD` permissions return setup errors before joining.

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

Voice-hinted ephemeral audio artifacts use object/artifact delivery, not arbitrary model-emitted path text. `MEDIA:/path` text remains normal text unless an existing non-auto file-delivery path explicitly handles it with its own path checks. Telegram sends compatible `.ogg`, `.opus`, and `audio/ogg` artifacts as voice bubbles; voice-hinted incompatible audio converts through ffmpeg when available and otherwise falls back to normal audio delivery.

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
- durable pending gateway approvals live in the global session DB table `pending_approvals`, scoped by `profile_id`
- delivery logs live under the bound profile log state
- channel media and WhatsApp auth state live under the bound profile state paths
- gateway process registry entries are profile-tagged

Gateway turns rebuild runtimes from fresh selected-profile config snapshots. This helps MCP reload semantics, but the supervisor remains bound to the profile chosen at start.

Gateway voice state is also bound to the selected profile. Per-chat voice modes live under `gateway/voice-mode.json`; voice STT preprocess audit events live under `gateway/logs/voice-stt-preprocess.jsonl`; profile temp audio is used for auto-TTS, Telegram conversion, CLI recordings, and Discord voice receive files. See [Voice](./voice.md) and [Voice Operations](../operations/voice.md).

## Gateway Service Management

EstaCoda can install the gateway supervisor as a managed service:

- Linux systemd user services.
- Linux systemd system services.
- macOS launchd user LaunchAgents.

Commands:

```bash
estacoda gateway install
estacoda gateway install-service
estacoda gateway uninstall
estacoda gateway uninstall-service
```

Every installed service is bound to a profile. The generated launch command includes `gateway start --profile <profileId>`, and service names include a profile-derived hash suffix so profiles such as `work.prod` and `work-prod` do not collide. Multiple profiles can have independent service units installed at the same time.

Install examples:

```bash
estacoda gateway install
estacoda gateway install --profile work
estacoda gateway install --force
sudo estacoda gateway install --system --run-as-user estacoda
```

Uninstall examples:

```bash
estacoda gateway uninstall
estacoda gateway uninstall --profile work
sudo estacoda gateway uninstall --system
```

Service operation notes:

- Services inherit `HOME` but not the interactive shell environment.
- Secrets should live in the selected profile env file, for example `~/.estacoda/profiles/work/.env`.
- systemd user services may stop on logout unless linger is enabled with `sudo loginctl enable-linger $USER`.
- Source-mode service installs hardcode the workspace path and may need reinstall if the repo moves.
- `gateway stop` and `gateway restart` are service-aware: they prefer an installed user service and require `--system` to control a system service.
- `gateway start` remains process-oriented in v0.1.0 because installed units still launch the supervisor through `gateway start --profile <profileId>`.
- `gateway start --background` refuses to spawn an unmanaged process when a managed service, live PID file, or active gateway lock exists for the selected profile.
- `estacoda gateway status` includes a Service Manager block. The status command remains usable when systemd or launchd probing fails or is permission-limited.

## Gateway Approvals

Gateway approval prompts create durable rows in `pending_approvals`. Rows include `profile_id`, `session_id`, command preview/hash, transient command payload, tool name, status, expiry, channel, and optional chat id.

Approval invariants:

- Pending approvals are ask-only. Deterministic `deny` results and hardline command blocks never create approval rows.
- Profile A cannot list or resolve Profile B approvals.
- Session-scoped operations cannot resolve another session's approval.
- Expired or already resolved approvals cannot be approved later.
- Approved, denied, and expired rows redact `command_payload` where practical.
- List/history output uses preview/hash, not raw command payload.

Operator surfaces:

```bash
estacoda gateway approvals
estacoda gateway approvals list --profile work
estacoda gateway approvals approve <id> [--session <session-id>] [--profile <profile-id>]
estacoda gateway approvals deny <id> [--session <session-id>] [--profile <profile-id>]
```

Remote `/approve` and `/deny`, Telegram inline buttons, Discord buttons, and CLI/operator approval all route through `ChannelGateway` and the same durable queue resolution path. Future inline approval actions must reuse those same `ChannelGateway` approve/deny paths so persistent grant handling and runtime-cache refresh stay centralized. Adapters must not duplicate cache invalidation.

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
- `/approve once|session|always` — resolve the current pending approval for this chat
- `/deny` — deny the current pending approval for this chat
- `/revoke <approval-id>` — revoke a persistent channel approval
- `/stop` — abort the active turn for this chat; if no active turn, clear queued messages; if nothing is active or queued, request gateway stop
- `/model` — show ready/runnable model choices for this gateway conversation
- `/model <provider>/<model>` — set a conversation-scoped model override
- `/model set <provider>/<model>` — compatibility syntax for the same conversation-scoped override
- `/model clear` — clear the conversation-scoped model override
- `/model --global <provider>/<model>` — persist the selected route as the profile primary model only when channel authorization, workspace/profile trust, and profile config path proof are available

Gateway `/model` also supports plain-text fallback commands for channels without native actions: `model-select <provider>/<model>` and `model-clear`. Telegram and Discord render model picker actions where their adapters support actions; those callback payloads contain short opaque picker action tokens, not route/model identifiers or raw credentials. Model control commands, including picker callbacks, bypass busy-session queues so the operator can change or clear model state while a conversation is active. Normal user turns still follow the configured busy-session policy.

Gateway `--global` writes fail closed. If channel authorization, runtime workspace/profile trust, or profile config path proof is missing, the gateway returns terminal setup guidance and writes nothing. Successful global writes invalidate cached gateway runtimes that could still hold the old primary route. Gateway sessions do not collect credentials or OAuth tokens; use `estacoda model setup` from a terminal for credentials and primary setup, and `estacoda model fallback` for fallback route management. `/model --global clear` is rejected.

## Limitations

- Telegram is the only live-proven channel.
- Discord slash commands are deferred to v0.9.1.
- WhatsApp is experimental and uses an unofficial API with account-risk implications.
- Email live smoke is optional/manual.
- Gateway status reports readiness, not background-process liveness.
- Channel-specific safety rules are partial — general safety policy applies to all channels equally.
- Inline approval actions are transport/UI sugar over `ChannelGateway`; adapters do not own approval authorization.
