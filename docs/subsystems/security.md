---
title: "Security"
description: "Security model: policy, approvals, trust, channel allowlists, handoff codes, and global policy."
---

# Security

EstaCoda uses a capability-first security model where tool risk classes, approval modes, workspace trust, and channel allowlists work together to bound agent behavior across all surfaces.

## Files

| File | Lines | Role |
|------|-------|------|
| `src/security/security-policy-factory.ts` | ~180 | Create policy for approval mode |
| `src/security/workspace-trust-store.ts` | ~160 | Persist workspace trust grants |
| `src/security/workspace-approval-controller.ts` | ~240 | Manage approval grants and scopes |
| `src/security/command-safety.ts` | ~200 | Command classification and hard floor |
| `src/contracts/security.ts` | ~120 | Security types and defaults |
| `src/channels/channel-approval-store.ts` | ~180 | Approval persistence per channel |
| `src/channels/handoff-store.ts` | ~150 | Short-lived handoff codes |

## Approval Modes

| Mode | Behavior | Evidence |
|------|----------|----------|
| `strict` | Ask for approval on almost all tool executions | `smoke-tested` |
| `adaptive` | Deterministic triage first, then optional auxiliary assessor for ambiguous cases | `smoke-tested` |
| `open` | Minimal gating, but hard floor still applies | `smoke-tested` |

Default: `adaptive`

## Tool Risk Classes

| Class | Examples | Gating |
|-------|----------|--------|
| `safe` | File reads, web search | None |
| `caution` | File writes, edits | Adaptive or strict |
| `external-side-effect` | Network POSTs, external APIs | Usually gated |
| `irreversible` | Deletes, deployments, sends | Always gated |

## Hard Floor

The unconditional hard floor covers:

- Broad/root-like recursive deletes
- Destructive disk operations
- Shutdown/reboot commands
- Fork-bomb or kill-all patterns
- Explicit secret reads
- Pipe-to-interpreter installs
- Git force-pushes

`/yolo` is a session-scoped toggle for `open` mode but **cannot bypass the hard floor**.

## Approval Scopes

| Scope | Duration |
|-------|----------|
| `once` | Single execution |
| `session` | Until session ends |
| `always` | Persisted until revoked |

Persistent approvals match on normalized `targetKey` values, including operation type and normalized targets.

## Workspace Trust

- Trusted workspaces allow normal local work in that directory to proceed proactively.
- Obvious risk classes still trigger approval logic.
- Trust is global directory-owned state persisted per workspace root in `~/.estacoda/trust.json`.
- Trust does not control config loading. Runtime config always comes from the selected profile.

## Channel Security Model

### Global Policy

All channels share the **same runtime security policy**. There is no channel-specific approval escalation. Email does not add email-specific approval friction; Discord does not add Discord-specific friction; WhatsApp does not add WhatsApp-specific friction. The configured `strict`/`adaptive`/`open` mode applies uniformly.

### Channel Allowlists

| Channel | Allowlist By | Config Key |
|---------|--------------|------------|
| Telegram | `userId`, `chatId` | `allowedUsers`, `allowedChats` |
| Discord | `userId`, `guildId`, `channelId` | `allowedUsers`, `allowedGuilds`, `allowedChannels` |
| Email | sender address | `allowedSenders` |
| WhatsApp | `userId` (phone/JID) | `allowedUsers` |

**Email `allowAllUsers`:** When `true`, sender filtering is bypassed. All email senders are treated as allowed. This is useful for public-facing email bots but increases exposure.

**WhatsApp experimental gate:** The WhatsApp adapter only initializes when `channels.whatsapp.experimental: true`. This is a deliberate gate to prevent accidental use of the unofficial Baileys API.

### Handoff Code Security

CLI↔Telegram handoff uses short-lived, single-use codes:

- **Randomness:** `crypto.randomInt` (Node.js `node:crypto`), not `Math.random`.
- **Alphabet:** Crockford-like base-32 (32 chars, visually unambiguous).
- **Keyspace:** 32^6 = ~1.07 billion combinations.
- **TTL:** Configurable, default 10 minutes.
- **Single-use:** Codes are marked redeemed after first successful use.
- **Atomic writes:** `handoff-codes.json` is written via temp-file + rename with `0o600` permissions.
- **No leakage on failure:** Failed redemption returns generic messages; no session ID is revealed.
- **No rate limiter in v0.9:** Brute-force mitigation relies on short TTL + keyspace + single-use + gateway allowlist.

See [Handoff Preflight Report](../security/handoff-preflight-report-v0.9.md) for full audit details.

### Surface Pointer Behavior

- Surface pointers are stored under the bound profile gateway state.
- They link a surface (e.g., `telegram:chat-1`) to a SQLite session ID.
- **No automatic context merge:** attaching a Telegram surface to a CLI session does not merge histories or messages. It only means future Telegram messages go to that session.
- Detaching creates a new independent session for that surface.

## Security Audit

Interactive CLI sessions expose `/security` and `/security debug` for inspecting recent decisions, target keys, deterministic rule hits, and assessor status.

Gateway diagnostics (`estacoda gateway diagnose`) surface missing credentials and configuration warnings per channel.

## Adaptive Assessor

- Defaults to auxiliary `assessor` route when enabled without explicit provider/model override.
- Assessor failures, malformed output, or timeouts fall back to `ask`.
