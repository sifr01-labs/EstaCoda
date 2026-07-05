---
title: Gateway internals
description: Gateway supervision, channel adapters, runtime caching, approvals, and resilience boundaries.
sidebar_position: 6
---

# Gateway internals

The gateway is EstaCoda's long-running channel process. It hosts configured channel adapters, maps inbound channel messages to sessions, creates or reuses runtimes, delivers responses back to the channel, and keeps enough state to diagnose service health.

This page is for maintainers and operators debugging `estacoda gateway run`, managed gateway services, channel delivery, approvals, stuck turns, or adapter lifecycle behavior. User-facing setup lives in [Channels](../user-guide/channels.md). Operational runbooks live in [Gateway Operations](../operations/gateway-operations.md).

---

## What this page covers

Use this page when you need to inspect:

- why a gateway process did or did not start
- which channel adapters were registered and whether they are healthy
- why an inbound message did not become a turn
- whether a runtime was reused, recreated, suspended, or evicted
- why a session was considered busy or stuck
- how channel-mediated approvals are queued and resolved
- where gateway state files live
- which hooks and diagnostics should exist for a gateway run

The gateway is not a separate agent runtime. It uses the same runtime creation path as local sessions, but with a different lifecycle: the gateway is long-running, channel-driven, and may reuse runtime instances across incoming turns.

---

## Runtime shape

The gateway process is built from three layers:

| Layer | Role |
|---|---|
| Supervisor | Owns process lifecycle, locks, adapters, runtime cache, active turns, cron ticks, and shutdown. |
| Channel gateway | Maps channel messages to sessions, checks channel authorization, routes approvals, and delivers responses. |
| Runtime | Runs the normal agent loop for the resolved session and profile. |

Configured channel adapters can include Telegram, Discord, Email, WhatsApp, and any registered adapter that implements the channel contract. Adapter maturity is channel-specific. The gateway should not assume every adapter has the same delivery, polling, pairing, or approval semantics.

Inbound channel messages are handled as turns. The gateway resolves the channel/session surface, borrows or creates a runtime for that session, runs the agent loop, and routes the result through the channel delivery layer.

---

## Supervisor

`GatewaySupervisor` in `src/gateway/supervisor.ts` is the top-level coordinator.

It wires:

| Responsibility | Component |
|---|---|
| Adapter lifecycle | `AdapterResilienceSupervisor` per adapter |
| Runtime caching | `RuntimeCache` keyed by session |
| Turn tracking | `ActiveTurnRegistry` |
| Approval queue | `GatewayApprovalQueue` |
| Message/session routing | `ChannelGateway` |
| Delivery normalization | `DeliveryRouter` |
| Cron execution | `tickCron` with `CronStore` |
| Session hygiene | `SessionHygieneService` |
| Voice state | `VoiceStateManager` |
| Lifecycle observation | `HookRegistry` |

The supervisor owns process-level concerns. It does not make provider or tool safety decisions directly; those remain in runtime, tool execution, security policy, and the channel approval queue.

---

## State boundaries

Gateway state is profile-local. For profile `<id>`, normal gateway state lives under:

```text
~/.estacoda/profiles/<id>/gateway/
```

Important files include:

| File | Purpose |
|---|---|
| `gateway.pid` | Foreground/unmanaged gateway PID record. |
| `gateway.lock` | Process lock that prevents multiple gateways for the same profile state. |
| `gateway-state.json` | Supervisor lifecycle snapshot. |
| `adapter-runtime-state.json` | Adapter runtime state snapshot. |
| `runtime-cache-state.json` | Runtime cache and active-turn diagnostics. |
| `.clean_shutdown` | Marker written after a graceful shutdown path. |
| `channel-sessions.json` | Channel session mapping state. |
| `channel-approvals.json` | Channel approval surface state. |
| `delivery/` | Delivery overflow and artifact state. |
| `logs/` | Gateway-local diagnostic logs such as delivery errors. |

Some low-level helpers can also accept a global state home and derive `~/.estacoda/gateway/`. In normal profile-aware runtime paths, use the profile-local gateway state path from `resolveProfileStateHome(...)`.

---

## Runtime cache

The gateway uses `RuntimeCache` to avoid creating a fresh runtime for every incoming turn. Runtimes are keyed by `sessionId` and reused when the runtime fingerprint still matches.

| Cache behavior | Default |
|---|---|
| Max entries | 50 |
| Idle TTL | 30 minutes |
| Fingerprint mismatch | Creates a new runtime and retires the old entry. |
| Suspended entry | Creates a new runtime on the next borrow. |
| Dispose timeout | 10 seconds per runtime dispose attempt. |

Eviction reasons include:

| Reason | Trigger |
|---|---|
| `ttl` | Entry was idle longer than the configured TTL. |
| `lru` | Cache exceeded the max entry count. |
| `suspend` | Runtime was suspended after an error or stuck-loop path. |
| `fingerprint-mismatch` | Config/model/runtime fingerprint changed. |
| `invalidate` | Explicit invalidation. |
| `disposeAll` | Gateway shutdown or cache disposal. |

Runtime cache diagnostics are written to `runtime-cache-state.json`. The state is diagnostic only: it records counts, hashed stuck-turn keys, suspended summaries, and a runtime fingerprint hash. It should not contain message text, prompts, raw chat IDs, or secrets.

---

## Adapter resilience

Each channel adapter is wrapped in `AdapterResilienceSupervisor`.

The wrapper handles:

- start and stop lifecycle
- retryable start and poll failures
- adapter runtime state
- hook emission for observability
- WhatsApp bridge-specific error classification where applicable

Backoff defaults:

| Parameter | Default |
|---|---|
| Base delay | 1 second |
| Max delay | 60 seconds |
| Max attempts | 5 |
| Jitter | 20% |

Adapter state can move through states such as `starting`, `healthy`, `degraded`, `retry_scheduled`, `failed`, and `stopped`. Not every adapter exposes polling. If an adapter has `pollOnce`, the supervisor can poll it; callback-style adapters can deliver messages through their own start handler.

---

## Active turns

`ActiveTurnRegistry` tracks in-flight turns by a gateway session key. A key is usually derived from channel/session identity, such as a Telegram chat surface.

Defaults:

| Behavior | Default |
|---|---|
| Stuck threshold | 5 minutes |
| Max stuck checks | 3 |
| Busy ack cooldown | 30 seconds |
| Stuck-turn history size | 50 |

If a key already has an active turn, `ActiveTurnRegistry` returns `busy` instead of starting a second concurrent turn for the same key. The channel layer then applies the configured busy policy. Depending on channel configuration, that can mean reject, queue, or interrupt behavior.

Stuck scans increment a stuck-check count. Supervisor logic can record stuck events, abort stuck turns, and suspend a runtime after repeated distinct stuck-loop evidence for the same session. Treat stuck handling as a safety and resilience path, not as a guarantee that every blocked provider/tool operation can be recovered cleanly.

---

## Approval queue

Gateway approvals use a durable `pending_approvals` table in the session SQLite database. Rows are profile-scoped and may also be session-scoped.

`GatewayApprovalQueue` is responsible for:

- creating pending approval rows
- polling for approved or denied rows
- expiring stale approvals
- resolving approvals by ID
- keeping hardline and deterministic-deny decisions out of the approvable queue

Pending gateway approvals are ask-only. Deterministic denies and hard safety blocks must not become durable approval rows that can later be approved from a channel.

Channel adapters should not mutate the approval queue directly. Approval orchestration belongs in `ChannelGateway` and the queue.

Approval rows may represent command execution or managed Python capability setup. Managed Python setup approvals use `managed_python_capability_install`, carry only registered capability metadata, and are resolved by `ChannelGateway` through the trusted Python capability installer. They must not store provider-generated package lists or shell commands. After approval, the gateway invalidates the runtime cache entry for the session before replaying the original channel message.

---

## Service management

The gateway can run in the foreground or as a managed service.

Foreground and diagnostic commands:

```bash
estacoda gateway run
estacoda gateway run --dry-run
estacoda gateway run --once
estacoda gateway run --profile <id>
```

Managed service commands:

```bash
estacoda gateway install
estacoda gateway install --profile <id>
estacoda gateway install --force
sudo estacoda gateway install --system --run-as-user <user>

estacoda gateway start
estacoda gateway stop
estacoda gateway restart

estacoda gateway uninstall
sudo estacoda gateway uninstall --system
```

Supported managers are Linux systemd user/system services and macOS launchd user services. User-scope installs are the normal path. System-scope installs require systemd, root, and an explicit `--run-as-user`.

Generated services invoke `gateway run --profile <id>`. They use explicit service environment values, not necessarily the operator's interactive shell environment. Put channel tokens and provider credentials in the profile `.env`.

---

## Lifecycle

Startup normally does the following:

1. Resolve the active or requested profile.
2. Check gateway state directory and lock state.
3. Acquire `gateway.lock`.
4. Write `gateway.pid` and `gateway-state.json`.
5. Load runtime config and channel configuration.
6. Build adapter resilience wrappers.
7. Build gateway services such as delivery, approvals, runtime cache, and active-turn registry.
8. Start adapter lifecycle.
9. Run supervisor ticks, adapter polling where available, cron ticks, approval expiry, and diagnostics heartbeats.

Shutdown normally does the following:

1. Stop accepting new work.
2. Drain active turns up to the configured timeout.
3. Stop adapters.
4. Dispose runtime cache entries.
5. Remove PID, supervisor state, and adapter runtime state files.
6. Release `gateway.lock`.
7. Write `.clean_shutdown` only for a clean shutdown path.

If the previous process did not leave trustworthy clean-shutdown evidence, startup treats the prior run as unclean and runs stale-state cleanup where it is safe. In-flight turns are not automatically replayed from process memory. The session database remains the durable record for completed session state and pending approvals.

---

## Hooks

`HookRegistry` emits best-effort lifecycle events. Hooks are internal observation, not control flow. A failing hook handler should not break the gateway.

Event categories include:

| Category | Examples |
|---|---|
| Supervisor | `supervisor:start`, `supervisor:stop`, `supervisor:drain:start`, `supervisor:drain:complete`, `supervisor:crash` |
| Adapter | `adapter:start`, `adapter:stop`, `adapter:error`, `adapter:retry`, `adapter:degraded`, `adapter:recovered` |
| Session | `session:turn:start`, `session:turn:complete`, `session:turn:error`, `session:turn:abort` |
| Cache | `session:cache:hit`, `session:cache:miss`, `session:cache:evict` |
| Delivery | `delivery:success`, `delivery:error` |
| Voice/STT | `gateway:stt:preprocess` |
| Cron | `cron:tick:start`, `cron:tick:complete`, `cron:job:fail` |

Privacy rules:

- Do not emit message text, prompts, model output, tokens, raw adapter identities, raw HMAC keys, approval secrets, or raw chat/user IDs.
- Use hashed identifiers where session keys or channel identities are needed.
- Counts, durations, booleans, channel kind, adapter kind, opaque session IDs, turn IDs, entry IDs, job IDs, execution IDs, and error classes are acceptable.

---

## Inspection and tests

Useful commands:

```bash
estacoda gateway diagnose
estacoda gateway status
estacoda gateway approvals
estacoda gateway run --dry-run
estacoda gateway run --once
```

Useful files:

- `src/gateway/supervisor.ts`
- `src/gateway/adapter-resilience.ts`
- `src/gateway/active-turn-registry.ts`
- `src/gateway/approval-queue.ts`
- `src/gateway/hook-registry.ts`
- `src/gateway/runtime-cache-state.ts`
- `src/gateway/service-manager.ts`
- `src/channels/channel-gateway.ts`
- `src/channels/delivery-router.ts`
- `src/channels/session-hygiene-service.ts`
- `src/runtime/runtime-cache.ts`

Focused checks:

```bash
pnpm exec vitest run src/gateway/supervisor.test.ts
pnpm exec vitest run src/gateway/adapter-resilience.test.ts
pnpm exec vitest run src/gateway/active-turn-registry.test.ts
pnpm exec vitest run src/gateway/approval-queue.test.ts
pnpm exec vitest run src/gateway/runtime-cache-state.test.ts
pnpm exec vitest run src/gateway/service-manager.test.ts
pnpm exec vitest run src/runtime/runtime-cache.test.ts
pnpm exec vitest run src/channels/channel-gateway.test.ts
```

When debugging a gateway problem, start with `estacoda gateway status`, then inspect the profile-local gateway directory for state snapshots. If state files contain raw message text, raw chat IDs, tokens, or prompt content, treat that as a bug.

---

## Related

- [Architecture](./architecture.md) - system structure and state boundaries
- [Runtime](./runtime.md) - runtime creation and session boundaries
- [Tool runtime](./tool-runtime.md) - provider tool-call execution boundaries
- [Gateway Operations](../operations/gateway-operations.md) - service management and runbooks
- [Channels](../user-guide/channels.md) - channel configuration and setup
- [Security and Approvals](../user-guide/security-and-approvals.md) - approval behavior
