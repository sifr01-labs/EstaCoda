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
| `src/security/smart-approval-assessor.ts` | ~150 | Shared smart approval classifier path |
| `src/contracts/security.ts` | ~120 | Security types and defaults |
| `src/channels/channel-approval-store.ts` | ~180 | Approval persistence per channel |
| `src/gateway/approval-queue.ts` | ~320 | Durable gateway pending approval queue |
| `src/channels/handoff-store.ts` | ~150 | Short-lived handoff codes |

## Approval Modes

| Mode | Behavior | Evidence |
|------|----------|----------|
| `strict` | Ask for approval on almost all tool executions, after the hardline floor | `smoke-tested` |
| `adaptive` | Deterministic triage first, then optional shared smart assessor for destructive-local ambiguous cases | `smoke-tested` |
| `open` | Minimal gating for non-hardline actions, but the hardline floor still applies | `smoke-tested` |

Default: `adaptive`

## Tool Risk Classes

| Class | Examples | Gating |
|-------|----------|--------|
| `safe` | File reads | None |
| `read-only-network` | Web search/extract/crawl, browser snapshots/navigation reads | Network-aware read-only policy |
| `caution` | File writes, edits | Adaptive or strict |
| `external-side-effect` | Network POSTs, external APIs | Usually gated |
| `irreversible` | Deletes, deployments, sends | Always gated |

## Hard Floor

The unconditional hardline floor is based on `assessCommandSafety(...).hardBlock`. Any `hardBlock` is non-overridable. Severity is metadata and must not be used to decide whether a command can be approved.

The hardline floor runs before:

- one-time, session, and persistent approvals
- `/yolo` and `open` mode
- the smart approval assessor
- gateway durable queue approvals
- Telegram/Discord inline approval actions
- final terminal/process tool execution

The hard-block detector covers:

- Broad/root-like recursive deletes
- Destructive disk operations
- Shutdown/reboot commands
- Fork-bomb or kill-all patterns
- Explicit secret reads
- Pipe-to-interpreter installs
- Git force-pushes
- Permission destruction such as recursive `chmod 777 /` or `chmod 000 /`
- Device overwrites, firewall flushes, self-termination, Terraform destroy, destructive package removals, and destructive Git resets

`/yolo` is a session-scoped toggle for `open` mode but **cannot bypass the hard floor**.

## Command Safety Detector

`src/security/command-safety.ts` normalizes commands before matching:

- ANSI escape sequences are stripped.
- Unicode fullwidth characters are normalized with NFKC.
- Existing token-aware `rm` parsing is preserved.

The detector accepts an explicit `environmentType`: `host`, `docker`, `singularity`, `modal`, `daytona`, or `vercel_sandbox`. The default is `host`. EstaCoda does not guess container state from `/proc/1/cgroup`, `/.dockerenv`, or filesystem heuristics.

Core dangerous host patterns include:

- `rm -rf /` and broad root-like variants
- `mkfs.*`
- `dd if=/dev/zero of=/dev/...`
- redirects into block devices such as `/dev/sda` or `/dev/nvme...`
- shell fork bombs
- broad `chmod` or `chown -R` on system paths
- `curl ... | bash`, `curl ... | sh`, `wget ... | bash`, and `wget ... | sh`
- inline `eval(...)` or `exec(...)` forms
- `sudo`, `su -`, `passwd`, and `usermod` command-position uses
- system package removal and global package uninstall commands
- `git push --force`, `git push -f`, and `git reset --hard`
- Docker prune, Kubernetes delete, and Terraform destroy commands

Hardline patterns are never bypassed by environment type. Non-host/container execution may bypass only non-hardline `destructive-local` command-safety detections.

## Approval Scopes

| Scope | Duration |
|-------|----------|
| `once` | Single execution |
| `session` | Until session ends |
| `always` | Persisted until revoked |

Persistent approvals match on normalized `targetKey` values, including operation type and normalized targets.

Persistent approvals do not override hardline command blocks. The hardline check is evaluated before grants are considered.

## Workspace Trust

- Trusted workspaces allow normal local work in that directory to proceed proactively.
- Obvious risk classes still trigger approval logic.
- Trust is global directory-owned state persisted per workspace root in `~/.estacoda/trust.json`.
- Trust does not control config loading. Runtime config always comes from the selected profile.

## Browser And Web URL Safety

Network-capable browser and web tools enforce a separate URL-safety floor before the normal tool result is returned. Private and internal URLs are blocked by default, including loopback, RFC1918, link-local, multicast, unspecified, reserved, CGNAT, and equivalent IPv6 ranges. Cloud metadata endpoints are always blocked, even when private URLs are otherwise allowed.

The canonical config key is `security.allowPrivateUrls`; `browser.allowPrivateUrls` is a deprecated alias only. `ESTACODA_ALLOW_PRIVATE_URLS` overrides config and accepts `1`, `true`, `yes`, and `on` for true, and `0`, `false`, `no`, and `off` for false. Any other value fails config loading instead of silently changing the safety posture.

`security.websiteBlocklist` supports exact domain rules and wildcard suffix rules such as `*.example.com`. Rules may be configured inline in `domains` or loaded from `sharedFiles`; shared files use one rule per line, ignore blanks and `#` comments, and missing files warn and are skipped. The blocklist policy is enabled when at least one normalized rule is loaded.

Current protection coverage:

- `web.extract` guards the initial URL and every manual redirect before reading the response body.
- `browser.navigate` guards the initial URL and checks the final post-navigation URL, with best-effort cleanup to `about:blank` when a redirect lands on a blocked target.
- `browser.cdp` is an `external-side-effect` tool. URL-capable CDP methods including `Page.navigate`, `Target.createTarget`, `Runtime.evaluate`, and `Runtime.callFunctionOn` apply URL-safety, secret scanning, and website-policy checks to explicit URLs and obvious network/navigation literal URL expressions.
- Supervised local CDP request interception aborts metadata, private/internal, website-policy-blocked, and secret-bearing browser subresource requests. It does not proxy content and does not read response bodies.

Browser/web debug telemetry is disabled by default and is enabled only with `ESTACODA_BROWSER_DEBUG=true` or `ESTACODA_WEB_TOOLS_DEBUG=true`. Debug data is attached to individual tool results only and is redacted before storage or return, including secret-bearing URLs, auth headers, cookies, request/response bodies, raw Runtime expressions, full page text, and oversized nested payloads.

Known limits: there is no socket-level DNS rebinding or TOCTOU protection, runtime-expression guarding is not full JavaScript static analysis, and debug telemetry is not persistent session recording, video capture, or a dashboard.

## Channel Security Model

### Global Policy

All channels share the **same runtime security policy**. There is no channel-specific approval escalation. Email does not add email-specific approval friction; Discord does not add Discord-specific friction; WhatsApp does not add WhatsApp-specific friction. The configured `strict`/`adaptive`/`open` mode applies uniformly.

Gateway approvals use a durable `pending_approvals` table in the session database. Rows are profile-scoped by `profile_id`; list and resolve operations are also scoped by profile and may be scoped by session. Pending approvals are ask-only: deterministic `deny` results and hardline results never become approvable queue rows. Command payloads are transient and are redacted after approval, denial, or expiry; list and history surfaces use command preview/hash rather than raw payload.

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

### Voice Security Boundaries

Voice input is a remote-control surface when it arrives through a gateway. Gateway STT preprocessing runs before provider dispatch, worker startup, ffmpeg normalization, hosted STT, downloads, or temp writes. It canonicalizes `attachment.localPath ?? attachment.path` under profile-local allowed media/audio roots, validates file type and size, checks STT readiness, and denies gateway-triggered faster-whisper first-run downloads unless explicitly allowed.

Voice STT preprocess audit events are emitted through `gateway:stt:preprocess` and written to `~/.estacoda/profiles/<profile-id>/gateway/logs/voice-stt-preprocess.jsonl`. Deny/fail warnings use `[voice-stt-preprocess]`. Audit records use path hashes and safe attachment metadata instead of full private paths.

Voice credentials are direct environment variables only. The OpenAI audio resolver uses configured `apiKeyEnv`, then `VOICE_TOOLS_OPENAI_KEY`, then `OPENAI_API_KEY` only for the default voice env case. There are no voice credential pools, gateway brokers, managed fallbacks, `useGateway`, or non-env credential sources.

Auto-TTS is text-first and fail-open. Generated auto-TTS media is ephemeral, profile-temp scoped, and not inserted into durable artifact storage, session DB, artifact history, prompt context, or model-visible attachment lists. Arbitrary `MEDIA:/path` response text is not an auto-TTS signal.

Local STT risk classes are:

| Path | Risk |
|------|------|
| command without ffmpeg normalization | `read-only-local` |
| command with ffmpeg normalization | `workspace-write` |
| cached faster-whisper | `workspace-write` |
| first-run faster-whisper download allowed | `external-side-effect` |
| uncached faster-whisper download disallowed | `unavailable` |

## Security Audit

Interactive CLI sessions expose `/security` and `/security debug` for inspecting recent decisions, target keys, deterministic rule hits, and assessor status.

Gateway diagnostics (`estacoda gateway diagnose`) surface missing credentials and configuration warnings per channel.

## Memory Security Boundaries

Memory is durable prompt context, not policy. Local memory, recalled history, compressed summaries, and external provider output are all subordinate to system, developer, repo, `AGENTS.md`, security, and current user instructions.

Important memory trust rules:

- `AGENTS.md` is project context, not memory. It is not curated, compacted, promoted, mirrored, or recalled as learned memory.
- `SOUL.md` is protected safety/identity memory. Learned-memory deactivation and compaction paths must not suppress or rewrite it.
- Session recall is untrusted historical context. Recalled content is labeled and cannot override current instructions.
- Semantic compression summaries are reference-only historical context. They are redacted and prefixed, but they are not trusted as active instructions.
- Transcript-preserving semantic compaction keeps the parent transcript available for audit/history and continues work in the compacted child only on surfaces that adopt the child session.
- External memory recall is untrusted historical context. It cannot replace local memory or session recall.
- Memory File Compaction can target only `USER.md` and `MEMORY.md`; it must never compact `SOUL.md`, `AGENTS.md`, session history, shared memory, or promotion metadata.
- Memory-file critical pressure is diagnostic only. Overflow fails closed with structured errors; Memory File Compaction remains manual/tool-driven by default and is not automatic self-healing.

Workspace/profile scoping matters:

- Session recall is profile-scoped.
- When a workspace root is supplied, recall includes only sessions with matching workspace metadata.
- Metadata-less legacy sessions are excluded from workspace-scoped recall, but may appear in same-profile recall when no workspace root is supplied.

Secret handling:

- Transcript-grade redaction is used for semantic compression and external memory recall/mirroring paths.
- Scanner/safety rejection prevents secret-looking text from being promoted into local memory. Failed promotion persistence rolls back markdown and promotion metadata so rejected or stale promotion records are not rendered into prompt memory context.
- Promotion overflow after an otherwise successful response is non-fatal to the user turn and is reported through best-effort `memory-promotion-failed` diagnostics. Those diagnostics carry pressure/remediation metadata only and must not include raw promoted text or secrets.
- Semantic compression failure diagnostics, fallback diagnostics, and status output are redacted and bounded. Status output omits raw summaries and `previousSummary` content.
- Semantic compression may prune old large tool results before summarization, but that pruning is compression-input-only and must not mutate persisted session history.
- Preserved semantic compaction must write the compacted child transcript before marking the parent ended. Parent-side lineage/audit events are best-effort; child transcript creation and parent lifecycle marking are the durable preservation contract.
- External memory credentials and provider diagnostics are redacted before display.
- External memory recall and mirror-write audit events are metadata-only. They must not include raw recalled content, raw mirrored memory content, credentials, or provider secrets.
- Mirrored memory writes are opt-in and should not include secrets.
- Provider failures, mirror-write failures, compression event failures, external audit event failures, and status diagnostic failures surface as warnings rather than weakening local memory or security policy.

Prompt injection from historical or external memory is expected input. Retrieved text must be treated as data about prior context, not executable instruction.

## Adaptive Assessor

- Uses one shared implementation in `src/security/smart-approval-assessor.ts`.
- Uses the Providers Pass D `auxiliaryModels.assessor` route key.
- Route construction happens through `resolveAuxiliaryModelRoute("assessor", ...)`.
- Execution uses `executeAuxiliaryTask(...)`.
- Provider requests pass `tools: []`; the assessor is a classifier, not an agent.
- The JSON schema is `risk_score` (`0`-`100`), `reasoning` (one line), and `confidence` (`high`, `medium`, or `low`).
- Scores map as `0`-`30` to approve, `31`-`60` to escalate/manual ask, and `61`-`100` to deny.
- Timeout, abort, provider failure, missing route, malformed output, inconsistent output, or ambiguous output fails safe to `ESCALATE` / manual `ask`.
- The base policy and `WorkspaceApprovalController` both use this shared path.
- There is no `auxiliaryModels.approval` route and no legacy provider/model fallback assessor architecture.
- Hardline commands deny before assessor invocation; a post-assessor hardline check remains as defense in depth.
