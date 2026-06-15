---
title: "Channels"
description: "Channel architecture: gateway, adapters, session management, and multi-channel delivery."
---

# Channels

Channels are the surfaces through which users interact with EstaCoda. v0.9 supports four channels: Telegram, Discord, Email, and WhatsApp (experimental).

## Files

| File | Lines | Role |
|------|-------|------|
| `src/channels/channel-gateway.ts` | ~1,400 | Gateway auth, session, command, approval, and pairing orchestration |
| `src/channels/telegram-adapter.ts` | ~1,160 | Telegram-specific adapter |
| `src/channels/telegram-stream-text.ts` | ~180 | Partial Telegram stream sanitizer for provider-token previews |
| `src/channels/discord-adapter.ts` | ~400 | Discord-specific adapter |
| `src/channels/email-adapter.ts` | ~350 | Email-specific adapter (IMAP/SMTP) |
| `src/channels/whatsapp-adapter.ts` | ~900 | WhatsApp bridge-client adapter, identity policy, formatting, media validation, and final-only delivery |
| `src/channels/whatsapp-bridge-lifecycle.ts` | ~500 | Managed isolated WhatsApp bridge lifecycle, dependency readiness, and logs |
| `scripts/whatsapp-bridge/bridge.js` | ~450 | Standalone Baileys/Boom transport bridge package |
| `src/channels/delivery-router.ts` | ~430 | Normalized delivery path |
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
- Long final replies are chunked after Telegram formatting, using Telegram's 4096 UTF-16 code-unit text payload limit
- Chunk suffixes such as `(1/3)` count inside Telegram's payload limit
- Inline actions are attached only to the final text chunk
- Experimental response streaming defaults on for configured Telegram channels and edits Telegram messages during a turn; final `response.text` remains authoritative
- Activity labels localized (`en`, `ar`)
- Group sessions per-user by default
- Thread sessions shared by default
- Active chat → session mapping persists across gateway restarts

**Setup:**

```bash
estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_BOT_TOKEN --allow-user 123456789
estacoda channels enable telegram
estacoda gateway install
estacoda gateway start
```

Normal guided setup asks for the Telegram bot API token, allowed Telegram user IDs, and allowed Telegram group chat IDs. It does not ask the user to choose the token env-var name. The collected token is stored under `ESTACODA_TELEGRAM_BOT_TOKEN`, and config points at it with `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"`. The raw bot token must not appear in config review, setup output, gateway diagnostics, or logs.

Operator-facing setup steps:

1. Use `@BotFather` and `/newbot` to create or select a Telegram bot and copy its API token.
2. Use `@userinfobot` and `/start` to retrieve allowed Telegram user IDs.
3. For group chats, add the EstaCoda bot plus `@getidsbot` or `@chatIDrobot` to the group. The ID bot replies with the group chat ID.
4. Group chat IDs are usually long negative numbers.

**Experimental streaming path:**

Telegram streaming is a delivery-UX path, not runtime state. It defaults to enabled for configured Telegram channels and can be disabled per profile with `channels.telegram.streaming.enabled: false`. Provider-token events are consumed by the gateway and appended to a per-turn stream handle. Non-token runtime events continue through normal progress delivery.

The intended visible order is:

```text
streamed text -> tool progress -> streamed continuation -> final edit
```

On a provider tool boundary, the gateway signals a segment break before delivering tool progress. The adapter seals the current streamed message, clears the progress message slot for that chat, and later provider tokens create a new streamed message below tool progress. Sealed streamed messages are not edited into the final answer. The final edit applies only to the current live streamed segment.

The stream worker uses partial-only sanitization and lightweight HTML escaping. It does not run final Telegram formatting on partial edits. Final delivery still uses `formatTelegramReply()` and adapter-owned chunking. Flood-control retry exhaustion, oversized escaped partial payloads, provider fallback/failure cleanup, missing live final segments, approval boundaries, artifact boundaries, and final edit failures all require normal final text fallback. Active-handle degradation does not disable streaming globally for future turns.

Streaming is not used when `DeliveryRouter` is present in v1, and the gateway starts it only for Telegram sessions with an abort signal. It does not change session transcripts, memory, tool execution, approvals, artifacts, security policy, or workflow state.

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
estacoda gateway install
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
| Baileys linked-device login through isolated bridge | `experimental` |
| QR code login | `estacoda whatsapp` |
| DM text delivery | `experimental` |
| Media download/upload | `experimental` |
| Message chunking | `experimental` |
| Final-only replies | `experimental` |
| Voice-bubble delivery | `ffmpeg` optional |

**Important:** WhatsApp support is **experimental** and gated behind `channels.whatsapp.experimental: true`. The main runtime talks to a quarantined bridge package under `scripts/whatsapp-bridge/`; that bridge uses `@whiskeysockets/baileys`, which is an **unofficial API**. Meta may suspend WhatsApp accounts using unofficial libraries. Use at your own risk. See [Security](../security/handoff-preflight-report-v0.9.md) for risk details.

**Limitations:**

- DM-first messaging UX; group access can be policy-gated, but full group mention/routing UX is not complete yet.
- Live credential smoke is optional/manual.
- Bridge dependency readiness is checked before setup/startup; missing dependencies require an explicit repair/install step.
- WhatsApp device pairing-code setup is not exposed; `estacoda whatsapp` supports QR-only pairing.

**Setup:**

```bash
estacoda whatsapp
```

The wizard renders the WhatsApp QR code in the terminal. If no allowed sender is configured during setup, the channel is left in `dmPolicy: "pairing"` and is not reported as fully ready until user authorization is completed. WhatsApp user authorization codes are single-use, expire after 10 minutes, and are stored only as salted SHA-256 hashes in profile-local state; plaintext codes are shown once and are not written to config.

QR pairing is foreground and times out after 120 seconds with `Pairing timed out - run estacoda whatsapp to try again.` A logged-out state requires explicit re-pair/reset, and reset is constrained to the selected profile's dedicated WhatsApp auth directory.

WhatsApp identities are matched canonically: phone numbers and `@s.whatsapp.net` JIDs normalize to digits, `@lid` IDs normalize case-insensitively, and group JIDs normalize as `@g.us`. Profile-local alias state can associate an LID with a phone number without storing message content.

`mode: "bot"` ignores WhatsApp `fromMe` messages. `mode: "self-chat"` accepts intentional self-chat input, prefixes bot replies with `replyPrefix` (default `EstaCoda: `), and ignores echoed replies by recent sent message ID or that prefix.

WhatsApp is final-only: provider/tool progress is translated only into ephemeral WhatsApp presence, not visible progress messages. Final replies are formatted for WhatsApp's limited markup (`**bold**`/`__bold__` becomes `*bold*`, Markdown links become `text (url)`, headers become bold text, and code spans/blocks are preserved), then chunked by the adapter with a short internal delay between chunks. Where WhatsApp supports it, the first final-answer chunk quotes the inbound message.

Outbound media policy stays in the main runtime. The adapter sends the bridge only validated local file paths under explicit allowed roots such as the trusted workspace and profile-local media/temp roots, enforces upload size limits, and caches explicitly allowed remote media URLs locally before delivery. Converted and cached WhatsApp media is written under profile-local media/temp roots. The bridge does not fetch URLs, run `ffmpeg`, or decide workspace trust. Image, video, normal audio, voice/PTT audio, and documents use separate bridge media types. Voice-hinted incompatible audio converts to OGG/Opus with `ffmpeg` when available; if conversion is unavailable, EstaCoda sends normal audio with an explicit fallback caption.

Bridge stdout/stderr is captured in the selected profile logs as `whatsapp-bridge.log`. Dependency repair output is captured separately as `whatsapp-bridge-install.log`. Status/diagnostics distinguish disabled, pairing-pending, allowlisted-ready, open policy, bot mode, self-chat mode, group policy, and queue pressure.

## DeliveryRouter

`DeliveryRouter` is the normalized delivery path for all channels.

Voice-hinted ephemeral audio artifacts use object/artifact delivery, not arbitrary model-emitted path text. `MEDIA:/path` text remains normal text unless an existing non-auto file-delivery path explicitly handles it with its own path checks. Telegram and WhatsApp send compatible `.ogg`, `.opus`, and `audio/ogg` artifacts as voice bubbles; voice-hinted incompatible audio converts through ffmpeg when available and otherwise falls back to normal audio delivery.

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
- Target resolution: `origin` resolves to the source platform/session key, then delivery is handled like any other platform target.
- Local/silent handling: `local` writes the full text to disk, and `silent` returns success without delivery.
- Adapter handoff: channel targets receive full text by default through the resolved adapter. `DeliveryRouter` does not perform platform-specific chunking.
- Legacy truncation: explicit `maxOutputChars` remains as opt-in router truncation for legacy callers. There is no default router text cap.
- Error persistence: delivery failures are recorded and visible via `estacoda gateway status`.
- Progress/artifact variants: `deliverProgress`, `deliverArtifact`.

### Delivery Limits

Platform message limits belong to channel adapters because formatting and transport rules are platform-specific:

- Telegram formats replies first, then chunks the formatted payload in `telegram-adapter.ts`. Each outgoing `sendMessage` text payload, including suffixes such as `(1/3)`, must fit within Telegram's 4096 UTF-16 code-unit limit. Inline action buttons are sent only on the final chunk. If sending any chunk fails, later chunks are not sent and delivery reports failure.
- Discord keeps adapter-owned text chunking in `discord-adapter.ts`.
- WhatsApp formats for WhatsApp markdown, preserves code spans/blocks, then chunks in `whatsapp-adapter.ts`. Inter-chunk delay is internal adapter behavior, not a CLI/config option.
- Email and custom adapters receive full text unless they implement their own limits.

### Overflow And Hooks

When explicit legacy router truncation is used, the full output is saved locally for operator inspection. Overflow filenames are sanitized and may contain only safe components such as a timestamp, a safe platform label, and a short hash. They must not include chat IDs, email addresses, raw target strings, slash-derived path fragments, or colon-delimited target metadata.

Remote channel messages and public hook payloads must not expose local overflow paths. Delivery success hooks may include safe delivery metadata:

- `truncated`
- `overflowSaved`
- `chunkCount` (reserved for adapter-reported chunk counts)

Hooks and remote messages must not include `overflowPath`, `fullPath`, raw local filesystem paths, chat IDs, email addresses, or raw target metadata from overflow filenames.

### Deferred Delivery Work

These behaviors are intentionally separate from delivery routing:

- CLI pagination is deferred.
- Remote download links for overflow files are not implemented.
- A shared chunking refactor across all adapters is not part of this design; adapters continue to own platform-specific limits.
- Provider `maxTokens` behavior is independent from channel delivery limits.
- Runtime and tool-output compression are independent from channel delivery limits.

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

Gateway processes are bound to the profile selected at foreground run or service-install time. Changing `active-profile.json` does not mutate an already-running gateway. Runtime state is profile-local:

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

Every installed service is bound to a profile. The generated launch command includes `gateway run --profile <profileId>`, and service names include a profile-derived hash suffix so profiles such as `work.prod` and `work-prod` do not collide. Multiple profiles can have independent service units installed at the same time.

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
- `gateway run` is the foreground/debug supervisor path. `gateway run --dry-run` performs readiness checks without PID/lock writes, and `gateway run --once` performs one supervisor pass.
- `gateway start`, `gateway stop`, and `gateway restart` are service-aware: they prefer an installed user service and require `--system` to control a system service.
- `gateway start` requires an installed service. It no longer runs the supervisor directly and `gateway start --background` no longer spawns an unmanaged detached process.
- `gateway restart` fails when no managed service exists instead of creating a detached process. `gateway stop` still keeps the unmanaged PID/lock cleanup fallback where already supported.
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

# Persistent service for the active profile
estacoda gateway install
estacoda gateway start

# Foreground/debug gateway for another profile
estacoda gateway run --profile work

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

When a turn has active delegated children, interrupt-mode busy policy is demoted for ordinary inbound messages: they queue instead of aborting the active parent turn. Control commands still bypass the ordinary queue. `/stop` aborts the active parent turn and active child work, `/approve` and `/deny` continue to resolve pending approvals, `/status` can show bounded active-subagent summaries, and model/control commands keep their existing bypass behavior. Active-subagent detection is runtime-scoped and parent-session scoped, so child work in one session does not block unrelated sessions.

Gateway `--global` writes fail closed. If channel authorization, runtime workspace/profile trust, or profile config path proof is missing, the gateway returns terminal setup guidance and writes nothing. Successful global writes invalidate cached gateway runtimes that could still hold the old primary route. Gateway sessions do not collect credentials or OAuth tokens; use `estacoda model setup` from a terminal for credentials and primary setup, and `estacoda model fallback` for fallback route management. `/model --global clear` is rejected.

## Limitations

- Telegram is the only live-proven channel.
- Discord slash commands are deferred to v0.9.1.
- WhatsApp is experimental and uses an unofficial API with account-risk implications.
- Email live smoke is optional/manual.
- Gateway status reports readiness, not background-process liveness.
- Channel-specific safety rules are partial — general safety policy applies to all channels equally.
- Inline approval actions are transport/UI sugar over `ChannelGateway`; adapters do not own approval authorization.
