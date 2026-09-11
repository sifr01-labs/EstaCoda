# Desktop control service

Status: implemented in Desktop PRs 3–4. The private Node bridge exposes canonical Work/Inbox projections and supervisor-owned execution controls. Electron Main/preload/windows remain PR 5. See the [protocol](control-protocol.md), [ownership decisions](../../planning/workspace-execution-ownership-decisions.md) and [bridge record](../../planning/desktop-pr3.md) and [Work/approval record](../../planning/desktop-pr4.md).

## Launch and ownership

An owning process launches the installed Node entry point with `desktop-service --stdio --profile <id>`. The command requires an explicit profile and private non-TTY stdin/stdout. It bypasses interactive startup, setup, active-profile writes, workspace selection and automatic host startup. Stdout carries only framed protocol messages; launch failures on stderr use fixed messages. The hidden command is not an ordinary interactive CLI flow.

Credential-capable Main adds `--credential-fd=3` and supplies a separate duplex pipe as descriptor 3. Arbitrary descriptor numbers and paths are rejected. Without the explicit flag, no extra descriptor is inspected or opened. Main must still validate credential-window senders and select an owned compatible runtime binary in PR 5.

The bridge probes the existing supervisor through its private discovery and authenticated socket transport. The additive `{ probe: true }` handshake is handled only after token/instance/version validation, never by the Session executor. It returns identity and explicit readiness/generation capability metadata. Legacy `send`, `cancel`, `approval` and `inspect` request semantics are unchanged. Old hosts that cannot answer the probe require a compatible restart; Desktop never starts a competing host to repair compatibility.

Readiness is an observation, not execution ownership. A failed connection or a missing endpoint with a remaining ownership record reports disconnected; it does not prove Work stopped. There is no service install/enable action. Execution mutations reuse core on-demand startup, including installed-service ownership checks. Bootstrap itself does not start a host. Closing a bridge disposes its own input, output, observer, subscriptions and credential candidates without stopping the supervisor.

## Available methods and snapshots

Implemented handlers, intersected with the client's requested capabilities, are:

- `control.initialize/bootstrap/subscribe/unsubscribe/cancelRequest`.
- `work.list/get/activity` and `inbox.list`.
- `sessions.start/resume/send/cancelTurn` and `operations.inspect`.
- `tasks.pause/resume/cancel/retry/guide` and `approvals.resolve`.

Events are `control.ready`, `work.changed`, `activity.appended`, `attention.changed`, `service.warning`, and `service.shutdown`. Model/provider/connection and ordinary credential methods remain unavailable until their handlers ship. Session start requires an existing canonical target reference; target creation/selection extensions remain PR 9.

Bootstrap reads the selected profile through core's `configurationInspection` mode: a regular, non-symlink config file, at most 1 MiB, bounded on the same opened descriptor, without loading profile `.env` values into the bridge environment or emitting raw configuration warnings. Normal CLI/runtime config loading remains unchanged. The profile label is the selected profile ID. Configuration `ready` means core can normalize a configured model route; it does **not** certify credentials, provider availability, workspace trust or task readiness. Inbox separately reports missing credentials, authorization expiry, trust and supervisor problems. Active provider verification belongs to PR 6.

Each completed bootstrap retains one immutable snapshot with its own stream cursor. A newer bootstrap invalidates older subscriptions, pending capture and snapshot. Old asynchronous captures cannot overwrite a successor. Work/Inbox pagination uses opaque tokens bound to this bridge, snapshot epoch, query and page size. Snapshot pages remain immutable while events describe later changes; consumers must merge by canonical identity and resnapshot on gaps or history rewrites.

After bootstrap, runtime status and canonical Work observers poll every five seconds without overlapping their own reads. Supervisor probes time out after two seconds. Work/attention changes and new persisted activity enter the bounded journal; rewrites and removals require resync. This is persisted activity polling, not token streaming. Raw config, provider errors, tool arguments/results and host bodies are not forwarded. `control.ready` identifies the bridge stream, not a running agent. There is no second agent loop or scheduler.

## Bounds, cancellation and reconnect

- Input frames, including LF, are capped at 262,144 bytes before strict UTF-8 decoding. Incomplete input, malformed UTF-8 and framing errors cannot grow an unbounded buffer.
- At most 32 handlers remain outstanding; ordinary reads use at most 28 slots so request cancellation/unsubscribe retain capacity. Cancelled or timed-out handlers keep their slots until they actually settle, even if a backend ignores abort.
- Requests have a 30-second deadline. Cancelling a bridge request never substitutes for durable `sessions.cancelTurn`. Mutation outcomes that may have been dispatched remain uncertain on bridge timeout/cancellation; the owner receipt must be inspected.
- Backpressured stdout retains at most 64 queued frames / 1 MiB, in addition to the stream's current write. Overflow disconnects the client; graceful closure has a one-second drain deadline. EOF cancels client requests rather than promising to finish them.
- Replay retains at most 256 events / 1 MiB and 32 subscriptions. One ordered pump per subscription serves replay and live notifications, yielding after 16 events. The acknowledgement precedes replay. Event coverage must equal the negotiated stream's event set.
- Expired, future or replaced cursors require a snapshot. Unsubscribe and pre-ack cancellation remove their reservation. If a slow consumer falls behind retention or exceeds output bounds, the connection closes and the client must initialize/bootstrap again. No best-effort stream becomes a durable mutation queue.

A bridge restart creates a new instance and rejects old cursors/candidates. Reuse the original core-generated operation ID when inspecting uncertain mutations; do not blindly replay under a new ID. Desktop requires explicit supervisor `targetGeneration: true` before dispatch. The host validates the selected target generation, and canonical receipt identity includes it. Older hosts are refused; generationless CLI requests retain their existing behavior.

## Credential descriptor

Descriptor 3 uses bounded LF JSON-RPC frames (65,536 bytes), independently of stdout. Only three methods exist there:

- `credentials.stage`: `{ scope, value }` → `{ candidateId }`.
- `credentials.discard`: `{ scope, candidateId }` → `{ discarded: true }`.
- `credentials.closeWindow`: `{ windowId, generation }` → `{ closed: true }`.

`scope` contains `windowId`, positive `generation`, `purpose` (provider/telegram), `providerId`, `authMethod` (api_key/oauth), and exact `endpoint`. Profile and bridge identity come from the trusted process, not message fields. Telegram scope uses its fixed API endpoint. Staging does not contact endpoints; provider verification must apply URL/spend policy in PR 6.

Values stay only in memory, with an idle TTL of five minutes and an absolute TTL of fifteen minutes measured monotonically. Limits are eight candidates/window, 32/bridge, 64 window-generation records and 49,152 value bytes (also subject to the whole frame bound). Advancing a window generation discards its older candidates; closing it fences late callbacks. Main must advance/invalidate that generation when the user's route/purpose/window changes. Idle touches cannot extend absolute expiry. Pipe/bridge close drops all candidates.

Replies contain opaque IDs or fixed errors, never values. No ordinary RPC credential route exists. There is no verification, OAuth exchange, Apply or secret persistence in PR 3. PR 6 must compose this staging with reviewed single-use transactions and recovery; internal candidate access grants no Apply authority. JavaScript cannot guarantee memory zeroization.

## Proof and remaining gates

Tests exercise real Node child processes and inherited descriptor 3, authenticated temporary supervisor endpoints, multiple same-profile bridges, another profile, bridge and host replacement, stale cursors/candidates, immutable snapshots, UTF-8/frame limits, replay ordering/eviction, cancellation and slow output. Canary credentials are absent from ordinary output and candidate acknowledgements, and active-profile selection remains unchanged.

The PR 4 lifecycle harness runs real Desktop CLI child processes against the authenticated private endpoint and a fake runtime owned by SharedSessionHost. It covers start/send, disconnect/reopen at approval, forged resolutions and receipt reconciliation without redispatch. Core tests cover generation binding, queue expiry/hardline policy, profile isolation, ended Task origins and status/grouping. These tests do not claim live provider execution, signed Electron behavior or OS credential-window isolation.

## Work and approval policy

Work is a projection of Sessions, Tasks, attempts and profile-owned schedules;
there is no second lifecycle database. SQLite capture is read-only and does not
migrate state. Bootstrap captures navigation metadata and a recent Session activity
preview capped at 1 MiB across the profile. Full transcripts load through bounded
`work.activity` pages using append-only message/event high water marks. Core
transcript rewrite revisions invalidate old history pages; new messages do not
shift an existing page. Sessions and Tasks no longer have the 1,000-record cutoff,
and long histories do not prevent access to Work or Inbox. Navigation metadata
still scales with the number of Work items; this is not a large-profile load-test
certification. Task activity retains the existing core result/plan summary limits.

Pages are capped at 100 items and 96,000 serialized item bytes. Opaque continuations
are authenticated with a fresh per-snapshot key and bind query, offset and page
size. Repeated reads are stable and forward paging does not consume a token cache.

Completion comes from canonical outcome records. A new user turn cannot inherit
an older completion. New outcomes reference the canonical user turn; compression
preserves that identity, and ambiguous legacy timestamp ties remain unconfirmed. Queued, active, blocked, partial, failed and cancelled states
remain distinct; completion and result availability do not prove external effects.
Display text is redacted and bounded. Unavailable usage/cost is null.

Desktop approvals use GatewayApprovalQueue. Pending action authority, tool/risk,
profile, Session and target generation remain backend-bound. The runtime grants
once after queue resolution and revalidates immediately before continuation.
Desktop exposes no reusable approval grants. Task approvals use TaskApprovalService;
channel continuations stay in ChannelGateway. App exit leaves the owner running.
Supervisor restart expires orphaned Desktop waits rather than replaying an action.
Stop/deny and durable Task controls preserve their core lifecycle semantics.

Work and Inbox expose backend-computed `actions` with enabled/disabled state and
fixed disabled reasons. Task control hints include the origin Session and optional
retry Step, so independent Tasks need no renderer inference. Retry hints account
for waiting state and Attempt limits. Target checks use the core read-only target
store; trust/setup blockers disable continuation hints while Stop/Pause/Reject
remain available. Hints are not grants: the owning core service revalidates every
mutation. Older projections without `actions` mean unknown availability.

Blocked Session outcomes appear in Inbox, and `waiting_for_host` Tasks display as
queued with their wait reason. Execution cancel, Task pause/cancel, and approval
resolution share the reserved request capacity with RPC cancellation/unsubscribe;
ordinary reads cannot exhaust those slots.
