# Runtime acquisition, shared ownership and recovery

PR 4 adds persisted Session execution ownership and a private control endpoint to the existing profile supervisor. Foreground CLI and ACP remain daemon-free. All use the same Session owner checks. This is host execution infrastructure; it does not add Docker containment, managed worktrees, a Desktop bridge or remote workspace-selection commands.

## Acquisition and lifetime

The runtime coordinator resolves the canonical workspace, establishes or validates the Session's immutable profile and execution target, acquires its persisted owner claim, and verifies/acquires the environment lease. Failed construction unwinds acquired resources. Owner release and database closure occur only after successful resource cleanup; uncertain cleanup retains the claim and its database handle. Task execution retains its host and Attempt admission before acquiring the executor Session owner. Child Sessions acquire independent claims and resource scopes.

A Session claim in the global `sessions.sqlite` database includes its profile, target, owner identity, PID, fence, heartbeat, expiry and turn/control revisions. SQLite serializes claims across processes. A live owner remains exclusive even when its heartbeat expires. Only confirmed process absence permits crash recovery; an inaccessible PID or a live reused PID remains busy. Cache entries, Session IDs, socket failures and old timestamps cannot grant ownership.

Runtime turns serialize per Session. Dispatch and authoritative SQLite writes validate the claim; SQLite mutation checks and writes share a short transaction/savepoint. No transaction spans provider or tool I/O. A stale or cancelled owner cannot settle a late result through those guarded runtime paths. This does not make an external API call or filesystem mutation transactional with SQLite.

Disposal cancels execution, waits for actual tool settlement and required resource cleanup, and then releases the claim. Shared resources retained by independent child scopes can keep the retired root claim held until their final cleanup. Child owners retain shared state through their own claim release, so closing their command scope cannot close the database prematurely. Failed cleanup retains ownership rather than declaring a successful handoff. A cached runtime borrower releases its reference; the cache owns runtime retirement. Simultaneous cold acquisitions construct one runtime, and replacement waits for the old runtime to settle.

Foreground-to-shared movement requires settled foreground disposal followed by explicit acquisition of that established Session. A live foreground owner produces a busy response. There is no live transfer of provider streams, shells, browser sessions or unsaved ACP buffers. Closing a private-control connection only detaches that client; accepted supervisor work continues. Existing supervisor drain and explicit stop behavior govern its lifetime.

## Configuration, trust and definitions

The selected profile remains the only runtime configuration source. Workspace trust gates actions and never merges project configuration. Gateway acquisition reloads that profile's configuration and current workspace trust. Runtime construction and MCP exposure use that snapshot. Channel policy assessments also read current security mode and assessor configuration.

Runtime revisions distinguish cosmetic metadata, construction inputs, instruction/tool definitions and authority. Cosmetic changes alone keep the cached runtime compatible. Behavior changes rebuild at acquisition after prior ownership settles. A rebuild is busy while an incompatible runtime is borrowed. Definition revisions are provenance, not permission.

Active runtime validation checks the current Session/target binding, persisted trust, relevant security/capability configuration, credential availability and retained approval revisions. Empty env values and removed/empty OAuth entries count as unavailable even when the files still exist; nonempty token refresh remains compatible. It runs at dispatch/settlement boundaries and on a watchdog. Revocation cancels execution and releases owned command resources; cache eviction alone is not the enforcement mechanism. Metadata-only edits do not invalidate an approval. Authority checks follow actual operation lifetimes and are retired after settlement; background commands retain their originating checks until process cleanup. Completed calls therefore do not accumulate an ever-growing validation list. The provider resolver continues to own credential resolution; an already dispatched provider request cannot be retroactively recalled.

Loaded instructions remain stable within a constructed runtime. Editing skill files directly does not hot-patch an active prompt or install a general filesystem watcher. Those edits are loaded on reconstruction; use settled runtime invalidation/reacquisition when applying file-only definition changes. Checkpoint provenance records the definitions actually loaded, including instruction/tool behavior, while current governance always controls continuation.

## Supervisor singleton and private transport

Each profile's gateway directory contains a transactional singleton store and discovery metadata. Acquisition and stale metadata cleanup are serialized. Discovery carries an instance ID, and release cannot delete a successor's instance. Malformed ownership metadata fails closed; repair requires establishing that the recorded process is absent, not merely deleting an old timestamp.

The minimal endpoint is a Unix-domain socket with a private directory, owner-only socket/discovery permissions, symlink checks, bounded frames/connections and a fresh per-instance secret. Profile and local operator identity come from the authenticated server context. Caller-supplied profile labels are not authority. Clients must match protocol and package version. Secrets stay in restricted discovery state and are not command arguments, provider input or log output.

Unix socket paths must fit the implementation's 100-byte bound. With a longer profile path, shared control is unavailable and the supervisor warns; foreground and existing background services remain available. Windows shared control is explicitly unsupported until protected named-pipe support ships. No TCP fallback is provided.

The exported `callPrivateControl` helper in `src/gateway/private-control.ts` supports `send`, `cancel`, `approval` and `inspect` for an already established Session/target. It is a core client API, not a new public CLI command. Resolve the selected profile's gateway directory with `resolveProfileStateHome`; do not construct paths from provider input.

An explicit `startIfNeeded: { homeDir }` option starts shared hosting on demand. It validates the Session target and workspace trust, reuses an installed service when present, or launches the existing supervisor command from the EstaCoda installation as a detached process. It never installs a service, changes the active profile or executes a workspace-supplied entry point. Ambiguous service scopes/ownership fail closed. An existing incompatible host must be handled through its lifecycle; clients must not launch a competing scheduler. The detached host uses existing supervisor lifetime policy; automatic idle shutdown is not introduced here.

## Operation receipts and priority controls

Generate one operation ID with `createControlOperationId()` for each new action and keep it until the result is reconciled. `send` also carries text; `approval` carries the issued approval ID and an approved/denied decision. Every request includes the existing Session and target IDs. These routing handles do not bypass profile, trust, ownership or approval checks.

Acceptance persists a receipt and its exact input in the existing Session event store before acknowledging it. Receipt identity is bound to profile, authenticated local principal, method and operation ID. Conflicting input under an existing ID is rejected. Repeating the exact action returns the stored receipt and does not execute it again. `inspect` with that operation ID returns receipts and current shared-turn/approval status. Completed sends reference the Session transcript; receipts are not a duplicate transcript store.

Cancellation and approval bypass the normal input queue. Cancellation reaches the shared turn or the channel owner's active turn. Channel approval waits are resolved as denied through the gateway and their continuations are removed, preventing later approval polling from resuming a cancelled wait. `cancellationRequested` reports whether an active turn or approval wait was reached; `terminationConfirmed` remains false because an acknowledgement cannot prove OS processes or external effects settled. Cancellation also invalidates shared inputs already queued for that Session; channel queue semantics remain owned by `ChannelGateway`.

Local decisions on channel approvals route through `ChannelGateway.resolveOperatorApproval`, including scoped queue resolution, continuation and delivery. Clients do not forge channel messages or directly mutate approval rows. Managed dependency installation retains its channel setup approval flow. Shared interactive approvals are one-time grants for the exact pending request.

Receipts are bounded to 10,000 per profile and retained for 30 days, with cleanup on host recovery. A previously unseen operation ID is accepted only within five minutes of its creation. After retention expires, an old ID is unknown and rejected; callers must reconcile the prior result before creating another action. Restart marks prior accepted/dispatched receipts uncertain, and does not blindly replay them. A response lost after acceptance must be inspected/retried with the same ID, never automatically resubmitted under a fresh ID.

## Checkpoint migration and uncertain effects

Checkpoint format version 1 gains an additive execution binding: target/generation, workspace identity, current definition/authority revisions and original provenance. Existing checkpoints remain readable. Migration requires an independently established matching Session target; it never invents authority from a stored path. Legacy provenance is explicitly marked unknown. A target mismatch blocks recovery.

Compatible resume records a binding revalidation without advancing semantic progress. Current definition and authority revisions may change while original provenance remains retained. Approval, trust and execution-owner checks still apply. A stored approval or checkpoint cannot revive revoked authority.

A dispatched or uncertain mutation requires verification/reconciliation, or operator intervention when its outcome cannot be established. Fences prevent stale authoritative settlement; they cannot undo a completed network request, recall credentials already sent, or guarantee containment of escaped descendants. No general exactly-once or exactly-once external side-effect guarantee is made.

## Validation boundary

Local tests cover independent-process claim exclusion and death recovery, stale-result fencing, cache contention, live revocation, singleton cleanup, authenticated IPC, durable retry receipts, priority controls and checkpoint migration. The [PR 4 record](../planning/workspace-execution-pr4.md) lists executed checks. Signed Desktop lifecycle, two-window/channel attachment, Windows IPC, Docker and production provider/account testing remain their respective delivery gates. See also [host execution limits](host-execution.md) and [workspace behavior](workspaces.md).

## Channel views and recurring execution

PR 5 routes workspace selection through the same profile-local target registry and Session preparation path. Selecting an alias changes future channel work only. Pointer mutations wait for existing input, queued work and approval handling to settle. Attachment validates current profile/target/trust and rejects another live foreground owner. Joining or leaving a view does not evict an established shared runtime or migrate its resources.

Authenticated local operator decisions on channel approvals continue through `ChannelGateway`, including continuation and delivery. Persisted setup continuations require the complete original channel scope. Recurring jobs carry their origin through runtime construction, tool calls and child scheduling; current trust, target and channel authorization govern each run and delivery. See the [PR 5 record](../planning/workspace-execution-pr5.md). These core tests do not replace the packaged Desktop and live Telegram delivery proofs.
