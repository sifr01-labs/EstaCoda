# Desktop control service

Status: implemented in Desktop PR 3. This is a private Node bridge and read-only runtime status surface. Electron Main/preload/windows remain PR 5; Session/Task/approval projections and execution controls remain PR 4. See the [protocol](control-protocol.md), [ownership decisions](../../planning/workspace-execution-ownership-decisions.md) and [implementation record](../../planning/desktop-pr3.md).

## Launch and ownership

An owning process launches the installed Node entry point with `desktop-service --stdio --profile <id>`. The command requires an explicit profile and private non-TTY stdin/stdout. It bypasses interactive startup, setup, active-profile writes, workspace selection and automatic host startup. Stdout carries only framed protocol messages; launch failures on stderr use fixed messages. The hidden command is not an ordinary interactive CLI flow.

Credential-capable Main adds `--credential-fd=3` and supplies a separate duplex pipe as descriptor 3. Arbitrary descriptor numbers and paths are rejected. Without the explicit flag, no extra descriptor is inspected or opened. Main must still validate credential-window senders and select an owned compatible runtime binary in PR 5.

The bridge probes the existing supervisor through its private discovery and authenticated socket transport. The additive `{ probe: true }` handshake is handled only after token/instance/version validation, never by the Session executor. It returns identity and explicit readiness/generation capability metadata. Legacy `send`, `cancel`, `approval` and `inspect` request semantics are unchanged. Old hosts that cannot answer the probe require a compatible restart; Desktop never starts a competing host to repair compatibility.

Readiness is an observation, not execution ownership. A failed connection or a missing endpoint with a remaining ownership record reports disconnected; it does not prove Work stopped. There is no service install/start/stop action in this slice. Closing a bridge disposes its own input, output, observer, subscriptions and credential candidates without stopping the supervisor.

## Available methods and snapshots

Advertised methods are `control.initialize`, `control.bootstrap`, `control.subscribe`, `control.unsubscribe`, and `control.cancelRequest`, intersected with the client's request. Events are `control.ready`, `service.warning`, and `service.shutdown`. No Work, mutation, model, connection or credential method is advertised merely because its schema exists.

Bootstrap reads the selected profile through core's `configurationInspection` mode: a regular, non-symlink config file, at most 1 MiB, bounded on the same opened descriptor, without loading profile `.env` values into the bridge environment or emitting raw configuration warnings. Normal CLI/runtime config loading remains unchanged. The profile label is the selected profile ID. Configuration `ready` means core can normalize a configured model route; it does **not** certify credentials, provider availability, workspace trust or task readiness. Richer diagnostics belong to PRs 4/6.

Each completed bootstrap retains one immutable snapshot with its own stream cursor. A newer bootstrap invalidates older subscriptions, pending capture and snapshot. Old asynchronous captures cannot overwrite a successor. Work pagination is not implemented yet; PR 4 must bind its initial paged projections to this snapshot epoch rather than independently reading mutable pages under an old cursor.

After bootstrap, a single observer polls status every five seconds, with cancellation and a two-second supervisor-probe timeout. It emits fixed resync/configuration-change guidance on changes. It never forwards raw config, provider errors, tool arguments or host bodies. A new snapshot supplies updated state. `control.ready` identifies the bridge stream, not a running agent. There is no second agent loop or scheduler.

## Bounds, cancellation and reconnect

- Input frames, including LF, are capped at 262,144 bytes before strict UTF-8 decoding. Incomplete input, malformed UTF-8 and framing errors cannot grow an unbounded buffer.
- At most 32 handlers remain outstanding; ordinary reads use at most 28 slots so request cancellation/unsubscribe retain capacity. Cancelled or timed-out handlers keep their slots until they actually settle, even if a backend ignores abort.
- Requests have a 30-second deadline. Cancelling a bridge request never substitutes for durable `sessions.cancelTurn`. Mutation outcomes that may have been dispatched remain uncertain on bridge timeout/cancellation; the owner receipt must be inspected.
- Backpressured stdout retains at most 64 queued frames / 1 MiB, in addition to the stream's current write. Overflow disconnects the client; graceful closure has a one-second drain deadline. EOF cancels client requests rather than promising to finish them.
- Replay retains at most 256 events / 1 MiB and 32 subscriptions. One ordered pump per subscription serves replay and live notifications, yielding after 16 events. The acknowledgement precedes replay. Event coverage must equal the negotiated stream's event set.
- Expired, future or replaced cursors require a snapshot. Unsubscribe and pre-ack cancellation remove their reservation. If a slow consumer falls behind retention or exceeds output bounds, the connection closes and the client must initialize/bootstrap again. No best-effort stream becomes a durable mutation queue.

A bridge restart creates a new instance and rejects old cursors/candidates. Reuse the original core-generated operation ID when inspecting uncertain mutations; do not blindly replay under a new ID. PR 4 must implement trusted target-generation checks and receipt binding before advertising mutations: the current host explicitly reports `targetGeneration: false`.

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

The lifecycle harness uses a fake execution handler behind the real private endpoint. It proves bridge ownership/isolation and does not claim live provider execution, signed Electron behavior, OS credential-window isolation or target-generation enforcement. PRs 4–6 and the packaged release gates retain those obligations.
