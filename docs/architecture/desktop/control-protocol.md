# Desktop control protocol v1.0

Status: pure contracts, framing helpers, validators and conformance tests implemented in Desktop PR 2. PR 3 implements the [private service, byte-stream reader and bounded subscriptions](control-service.md). Execution/projection handlers remain later consumer work. [Process decisions](decisions.md) and [shared ownership](../../planning/workspace-execution-ownership-decisions.md) remain authoritative.

Source: [Desktop control modules](../../../src/contracts/desktop-control/index.ts), exposed through the private `@estacoda/control-protocol` package and Desktop's source facade. These modules have no Node/Electron runtime imports. Core's legacy private-host contract, authentication, framing and exports are unchanged.

## Wire profile and versions

Desktop uses a restricted JSON-RPC 2.0 profile over private stdio: one UTF-8 JSON object per LF-terminated frame. Batch requests, numeric/null request IDs, parameter arrays, CRLF, blank lines, duplicate keys (including escaped equivalents), extra envelope fields and mixed result/error envelopes are rejected. IDs are 1–160 characters from `A–Z a–z 0–9 _ . : -`. An error response can have a null ID only when no request can be identified; correlated response validation requires the original string ID.

`DESKTOP_PROTOCOL_VERSION` is `{ major: 1, minor: 0 }`, independent of both JSON-RPC's `"2.0"` marker and the supervisor's private wire `protocol: 1`. `control.initialize` must be first and occurs once per bridge connection. Major mismatch is incompatible. A same-major client negotiates the lower minor and the intersection of requested, known and actually implemented methods/events. Unknown future capability names are ignored during negotiation, not executed. A known schema is not proof that its handler exists. Do not advertise methods automatically from `CONTROL_METHODS`.

Minor evolution can add explicitly negotiated method/event capabilities. Existing payload shapes remain closed; incompatible field or semantic changes need a new versioned contract, not silently accepting unknown fields. A service-version string is metadata here; existing host-client exact binary/version checks remain inside the legacy transport.

## Validation pipeline

1. The transport bounds incomplete input **bytes** before buffering, rejects invalid UTF-8 with a strict streaming decoder, and separates LF frames without mixing stdout diagnostics. PR 3 owns byte decoding, timeouts, disconnect cleanup and backpressure.
2. `parseControlFrame` validates one decoded string frame, duplicate keys, JSON structure and envelope shape. It does **not** by itself validate a method, projection, sender or authorization.
3. `validateControlRequest(value, context)` checks strict method parameters and initialized/negotiated scope. Pass `null` only before initialization. Main/service construct context from the authenticated connection, never renderer authority fields.
4. Producers create safe projections through explicit field selection/redaction. `validateControlResponse(value, originalRequest, context)` checks the method's result schema, request ID, profile, pagination limit, Work/connection identity and exact mutation receipt binding. Unknown request IDs and uncorrelated replies are not applied.
5. `validateEventNotification(value, context, subscription)` validates typed payload and profile/instance/stream/subscription/event scope. Then use `cursorDisposition` before applying it.
6. `serializeControlFrame` rechecks JSON/envelope bounds and emits one LF. Call the appropriate semantic validator before serialization too. Never serialize a raw runtime event or an arbitrary provider exception.

Validators are not an execution authority engine. The core owner must still revalidate current target generation, trust, grants, profile/session ownership, action availability and owner fences at the mutation boundary. They also cannot detect every secret embedded inside a legitimate text field. Schema rejection of `apiKey`, `token`, raw arguments and extra fields supplements producer-side safe projections and redaction; it is not a content secrecy guarantee.

## Implemented method contracts

The [method map](../../../src/contracts/desktop-control/methods.ts) is the TypeScript source of truth; [runtime validators](../../../src/contracts/desktop-control/validation.ts) enforce these schemas. Future plan catalog entries are deliberately absent until their consumer slice.

| Method | Parameters | Result |
| --- | --- | --- |
| `control.initialize` | Protocol version, client version, selected profile, requested methods/events | Bound profile/bridge instance, negotiated version/capabilities and limits |
| `control.bootstrap` | Empty object | Selected profile label/configuration state, separate runtime readiness, capabilities and snapshot cursor |
| `control.subscribe` | Snapshot/replay cursor and expected event set | Subscription ID with the same starting cursor, or `snapshot_required` with reason |
| `control.unsubscribe` | Subscription ID | Whether it was removed |
| `control.cancelRequest` | Other request ID on this connection | Whether cancellation was requested; does not cancel a durable Session turn |
| `work.list` | Limit and optional page cursor | Bounded Work page |
| `work.get` | Work ID | Matching Work projection |
| `work.activity` | Work ID, limit and optional page cursor | Matching profile/Work activity page |
| `inbox.list` | Limit and optional page cursor | Attention page, with scoped approve-once data only for approval items |
| `models.list` | Limit and optional page cursor | Model readiness, credential presence state and route role; no credentials |
| `providers.list` | Limit and optional page cursor | Provider label, supported auth modes and readiness |
| `connections.list` | Limit and optional page cursor | Separate configuration/runtime/authorization state |
| `connections.get` | Connection ID | Matching connection projection |
| `sessions.send` | Operation ID, Session ID, target ID/generation, text | Bound durable receipt |
| `sessions.cancelTurn` | Operation ID, Session ID, target ID/generation | Bound receipt with explicit cancellation acknowledgement state |
| `approvals.resolve` | Same operation/Session/target binding, approval ID, approved/denied decision | Bound receipt; core validates actual available decision and pending action |
| `operations.inspect` | Original operation/Session/target binding and original mutation method | Bound accepted/dispatched/completed/uncertain/unknown/expired receipt |

Operation IDs use `timestamp:nonce`: a canonical nonnegative decimal Unix timestamp in milliseconds (a safe integer), a colon, and a nonempty nonce using the control-ID character set, with a total limit of 160 characters. Trusted Main/core callers must use the existing `createControlOperationId()` from `src/gateway/control-receipts.ts` (timestamp plus random UUID) when initiating a mutation and retain that exact ID across retries and inspection. Do not replace it with a bare UUID or assign a new ID on reconnect. This Node helper stays outside the pure protocol package; PR 3/5 consumers must call it from trusted code.

Desktop validates this format on mutation/inspection requests and receipts, without checking the current clock. Core first checks existing receipts and their exact input binding; only a previously unseen operation must fall within its five-minute acceptance window. This preserves reconciliation of old accepted work while refusing unseen expired operations. Receipt retention remains core-owned (currently 30 days); schema acceptance is not evidence that an operation was accepted or may be replayed.

Persistent mutations require an operation ID plus target generation. Connection-local subscribe/unsubscribe/request cancellation are ephemeral controls, not durable Work mutations. Their IDs are connection-owned and cannot refer to another window's resources. A target reference has only ID/generation; no path, owner fence, principal or caller-supplied profile is accepted in mutation parameters.

Session creation/resume, Task controls, provider setup, credential/OAuth submission, route changes, connection mutation, target creation, attachments/search, files/PTYs, artifacts/browser, settings and scheduling are not implemented method schemas yet. Add them when the corresponding backend consumer arrives. In particular, the existing host v1 transport has no expected-generation field; PR 3 must not strip the Desktop field and pretend it was enforced. Coordinate core support before advertising dependent methods, or leave them unavailable.

## Projections and event payloads

Work references canonical Session/Task/scheduled execution/Evolution IDs. It carries a profile, display status and optional safe target label/isolation summary, not a new lifecycle database. Waiting for approval/input maps to `needs_attention`, waiting for host to `queued` with a reason. Completed, partial, failed and cancelled remain distinct. No validator infers verified completion from tool success or elapsed time.

Activity is discriminated as message, assistant delta, tool summary, plan, result/evidence/usage or status. Routine tool activity has a bounded summary, not raw arguments/results. Evidence retains artifact references and verified/unverified/partial/failed labels; null usage/cost means unavailable, not zero. Inbox approval metadata binds Session/target, one-time scope and available decisions. Runnable models cannot report missing/expired credentials; configured connections do not imply a running gateway or authorized sender.

Every event notification uses method `control.event`; its parameters contain profile ID, subscription ID, cursor (bridge instance/stream/sequence), timestamp, type and typed payload:

| Event type | Payload |
| --- | --- |
| `control.ready` | Ready marker for the control connection, not evidence the execution supervisor is running |
| `work.changed` | Work projection |
| `activity.appended` | Activity projection, including assistant delta variant |
| `attention.changed` | Item ID plus attention projection, or null item for removal |
| `modelRoute.changed` | Safe model projection |
| `connection.changed` | Safe connection projection |
| `service.warning` | Fixed resync-required/runtime-unavailable/configuration-changed reason |
| `service.shutdown` | Fixed client-closed/profile-changed/service-restart reason |

The broader implementation-plan event list is future scope. This slice groups activity in one typed event; future granular events require explicit schema/capability additions.

## Bounds

| Boundary | Limit |
| --- | --- |
| Encoded frame including LF | 262,144 UTF-8 bytes; enforced before/after serialization |
| JSON graph | Depth 12, 8,192 nodes, 64 keys/object, 256 array elements |
| Generic JSON string | 65,536 UTF-16 code units plus total encoded-byte budget |
| Requested page / returned page | 1–100 items; result cannot exceed requested limit |
| Opaque page cursor | 1–512 unpadded base64url characters; semantic scope belongs to the service |
| Handshake names | 64 unique method/event names per set; label tokens bounded |
| Subscriptions / replay events | At most 32 / 256 advertised; service must also bound total buffered bytes |
| Send text / activity message / delta | 32,768 / 16,384 / 4,096 code units |
| Titles / summaries / plan steps | 240 / 2,048 code units / 64 steps |
| Counters, timestamps, target generations | Safe integers; nonnegative, with target generation at least 1 |

The whole-frame byte budget takes precedence over per-field/per-page maxima. Return fewer items with a continuation cursor when a valid page would exceed the byte budget. Truncate/split safe display text with an explicit producer policy; never silently truncate a command, approval identity or target binding. Reject sparse arrays, accessors, hidden properties, cycles, non-finite numbers, functions, symbols, prototype keys and serialization hooks. These are data contracts for decoded JSON; hostile same-process JavaScript proxies are not an IPC security boundary.

## Reconnect, ordering and cancellation

Bootstrap must acquire canonical display state and its cursor at a consistent boundary. PR 3 must hold/bind initial paged reads to that snapshot epoch, bind page cursors to profile/query/epoch, and serialize or invalidate overlapping resync reads. The pure PR 2 contract does not implement snapshot storage. While initial pages load, retain bounded subsequent events; if the boundary expires, require another bootstrap rather than mixing generations of state.

The stream belongs to the negotiated event set for that client context. `control.subscribe.events` asserts that coverage; it is **not** a filter that may silently skip sequence numbers. A subscribed acknowledgement must echo the requested cursor and cover the full negotiated event set. A different event set needs fresh negotiation/bootstrap and a new stream; it receives `snapshot_required` rather than a false continuity acknowledgement. PR 3 must assign contiguous sequence numbers to that stream and keep priority control traffic independent of it.

Deliver the subscribed acknowledgement before replay notifications. Begin replay strictly after the acknowledged cursor. For validated events, the next contiguous sequence applies, an already-seen sequence is ignored, and a gap/new instance/new stream requires a canonical snapshot. Scope validation precedes sequence handling; do not let a foreign-profile or old-subscription event advance the cursor. Overflow/expired buffer similarly returns `snapshot_required`. No event log becomes the durable mutation queue.

After bridge restart, drop old candidates, request handles and subscriptions, initialize against the new instance, rebuild state from a fresh snapshot and inspect outstanding receipts. A same-instance stream can resume only within retention. A profile switch replaces the entire context. A disconnected bridge never proves that supervisor-owned Work stopped.

The owner binds operation ID to profile, trusted principal, method and exact canonical input in durable receipts. A lost response is not a failed mutation. `unknown`, `expired` and `uncertain` require reconciliation; do not resend with a fresh ID to force execution. Inspection is read-only. `completed` means the control operation settled, not that every external effect was verified. Cancellation may remain `requested` even with a completed control receipt; only core evidence can set `confirmed`.

`control.cancelRequest` cancels pending bridge work where supported, not Session execution or an already committed apply. Route durable cancellation separately through `sessions.cancelTurn`. Cancellation/denial must not wait behind ordinary prompt/output queues. Connection close drops client resources, not shared execution ownership.

## Safe errors and proof obligations

`failureEnvelope` produces fixed messages from `CONTROL_ERRORS`. Standard codes cover malformed JSON/envelope, unavailable method, invalid parameters and internal failure. Application codes `-32001` through `-32010` cover version, initialization, scope, stale binding, operation conflict, unavailable service, snapshot required, uncertain outcome, limit and cancellation respectively. Error bodies accept no arbitrary message, stack or data field; raw exceptions must never be interpolated. An uncorrelated null-ID parse error is a transport diagnostic, not completion of an outstanding request.

PR 2 tests cover every declared method/event through the Desktop package, malformed/ambiguous inputs, field/byte/depth limits, safe errors, profile/request/target correlation, negotiation, subscription scope and cursor continuity. They are not live authority, durable receipt, byte-stream, backpressure or packaged lifecycle proofs. PRs 3–5 must enforce those obligations and rerun both core and protocol conformance suites. No migration or host wire-version change is part of this protocol addition.
