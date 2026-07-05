---
title: Security and Approvals
description: Security modes, approvals, workspace trust, and the hardline floor for v0.1.0.
sidebar_position: 8
---

# Security and Approvals

EstaCoda uses a capability-first security model. Tool risk classes, approval modes, workspace trust, and channel allowlists work together to bound agent behavior. The rules are visible, the defaults are conservative, and the hardline floor cannot be overridden.

---

## Approval Modes

| Mode | Behavior | Alias |
|---|---|---|
| `strict` | Ask for approval on almost all tool executions after the hardline floor | `manual` |
| `adaptive` | Deterministic triage first, then optional smart assessor for ambiguous destructive-local cases | `smart` |
| `open` | Minimal gating for non-hardline actions; the hardline floor still applies | `off` |

**Default:** `adaptive`.

In `adaptive` mode, the system first applies deterministic rules. If a command is ambiguous and destructive-local, the smart assessor classifies it. If the assessor is missing or fails, the system falls back to manual approval.

`/yolo` toggles `open` mode for the current session. It does **not** bypass the hardline floor.

---

## The Hardline Floor

The hardline floor is unconditional. It runs before approvals, `/yolo`, the smart assessor, and gateway queues. Any command that matches a hard-block pattern is denied. Severity is metadata only; it does not decide whether a block can be approved.

Hard-blocked categories:

- Broad or root-like recursive deletes
- Destructive disk operations (`mkfs`, `dd` to block devices)
- Shutdown or reboot commands
- Fork-bomb or kill-all patterns
- Explicit secret reads
- Pipe-to-interpreter installs (`curl ... | bash`)
- Git force-pushes
- Permission destruction (`chmod 777 /`, `chmod 000 /`)
- Device overwrites, firewall flushes, self-termination
- Terraform destroy, destructive package removals, destructive Git resets

The command safety detector normalizes input before matching: ANSI escapes are stripped, Unicode fullwidth characters are normalized with NFKC, and token-aware parsing is preserved.

---

## Tool Risk Classes

| Class | Examples | Gating |
|---|---|---|
| `safe` | File reads | None |
| `read-only-network` | Web search/extract, browser snapshots | Network-aware read-only policy |
| `caution` | File writes, edits | Adaptive or strict |
| `external-side-effect` | Network POSTs, external APIs | Usually gated |
| `irreversible` | Deletes, deployments, sends | Always gated |

---

## Approval Scopes

| Scope | Duration |
|---|---|
| `once` | Single execution |
| `session` | Until the session ends |
| `always` | Persisted until revoked |

Persistent approvals match on normalized `targetKey` values. The `targetKey` includes the operation type and normalized targets. Display summaries are **not** the approval boundary.

Persistent approvals do not override hardline blocks. The hardline check runs first.

---

## Workspace Trust

Workspace trust allows normal local work in a directory to proceed proactively. It is global directory-owned state persisted in `~/.estacoda/trust.json`.

- Trust does **not** control config loading. Runtime config always comes from the selected profile.
- Trust does **not** disable the hardline floor.
- Obvious risk classes still trigger approval logic even in trusted workspaces.

Trust is orthogonal to profiles. A profile selects configuration and credentials. Workspace trust gates local tool behavior for a directory.

---

## Channel Security

All channels share the **same runtime security policy**. There is no channel-specific approval escalation. Email does not add email-specific friction; Discord does not add Discord-specific friction.

### Allowlists

| Channel | Allowlist By | Config Key |
|---|---|---|
| Telegram | `userId`, `chatId` | `allowedUsers`, `allowedChats` |
| Discord | `userId`, `guildId`, `channelId` | `allowedUsers`, `allowedGuilds`, `allowedChannels` |
| Email | sender address | `allowedSenders` |
| WhatsApp | `userId` (phone/JID) | `allowedUsers` |

Email `allowAllUsers: true` bypasses sender filtering. WhatsApp requires `channels.whatsapp.experimental: true` to initialize.

WhatsApp user authorization is separate from WhatsApp device pairing: `estacoda whatsapp` links the device with a terminal QR code, while `dmPolicy: "pairing"` waits for a single-use hashed authorization code and is not open access. Telegram pairing remains config-backed and unchanged for now.

### Gateway Approvals

Gateway approvals use a durable `pending_approvals` table in the session database. Rows are profile-scoped. Pending approvals are ask-only: deterministic `deny` results and hardline results never become approvable queue rows. Command payloads are redacted after approval, denial, or expiry.

Managed Python capability setup can also use gateway approvals. When a selected skill needs a missing required registered capability, Telegram and other gateway surfaces can ask the operator to approve installing that capability. Approval installs only the registered capability packages and selected groups, then resumes the original request. Denial or expiry leaves the capability uninstalled.

### Handoff Codes

CLI↔Telegram handoff uses short-lived, single-use codes:

- 6-character Crockford base-32 codes from `crypto.randomInt`
- Keyspace: 32^6 (~1.07 billion combinations)
- TTL: default 10 minutes
- Atomic file writes with `0o600` permissions
- Failed redemption returns generic messages; no session ID leakage
- No rate limiter in v0.1.0; mitigation is short TTL + keyspace + single-use + gateway allowlist

---

## Browser and Web URL Safety

Browser and web tools enforce a URL-safety floor:

- Private and internal URLs are blocked by default (loopback, RFC1918, link-local, cloud metadata endpoints)
- Cloud metadata endpoints are always blocked, even when private URLs are otherwise allowed
- `security.allowPrivateUrls` is the canonical config key; `browser.allowPrivateUrls` is a deprecated alias
- `ESTACODA_ALLOW_PRIVATE_URLS` overrides config (`1`/`true`/`yes`/`on` for true; `0`/`false`/`no`/`off` for false)
- `security.websiteBlocklist` supports exact domains and wildcard suffixes such as `*.example.com`

`browser.cdp` is an `external-side-effect` tool. URL-capable CDP methods apply URL-safety, secret scanning, and website-policy checks.

---

## Failure and Recovery

**Denied action:** The command matched a hardline block or the policy returned `deny`. The tool does not execute. Check the security mode and the command risk class.

**Approval required:** The policy returned `ask`. Use `/approve` or `/deny` in the gateway, or respond to the CLI prompt. Persistent approvals can be revoked with `/revoke <id>`.

**Stale approval:** Persistent approvals persist until revoked. If behavior drifts, revoke old approvals and re-approve under the current policy.

**Revoked trust:** If a workspace is untrusted, local commands that would normally run proactively may now require approval. Re-trust with `estacoda trust` if the directory is safe.

**Unsafe command floor:** Even in `open` mode or with `/yolo`, hardline blocks remain active. If a command is blocked, it is blocked. Change the command, not the mode.

---

## How to Inspect

```bash
# Current security mode and recent decisions
/security
/security debug

# Gateway status including pending approvals
estacoda gateway status

# Gateway readiness per channel
estacoda gateway diagnose

# Channel allowlists
estacoda channels status
```

---

## Related

- [Architecture](../developer/architecture.md) — system structure and security layer
- [Runtime](../developer/runtime.md) — security policy wiring during runtime creation
- [Channels](./channels.md) — channel configuration and allowlists
- [Memory](./memory.md) — memory trust boundaries
