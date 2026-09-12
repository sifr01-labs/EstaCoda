# Shared workspace, target, and execution ownership decisions

Status: shared implementation decisions. PR 1 implements local workspace/target records and profile/workspace Session validation; see [implemented behavior and limits](../operations/workspaces.md). PR 3 implements local host environment/resource scopes and editor materialization checks; see [host execution behavior](../operations/host-execution.md). PR 4 implements fenced Session ownership and private Unix supervisor control; see [runtime ownership](../operations/runtime-ownership.md). PR 5 implements scoped channel selection, checked attachment and recurring authority; see the [PR 5 record](workspace-execution-pr5.md). PR 6 implements optional local Docker leases, host-tool admission boundaries and owned cancellation; see [Docker execution](../operations/docker-execution.md). PR 7 implements temporary-copy targets, version-2 copy-aware workspace storage, retained change artifacts and scoped application/recovery; see [temporary-copy workflows](../operations/temporary-copies.md). PR 8 consolidates core conformance and release validation; see the [PR 8 record](workspace-execution-pr8.md). Desktop PR9 implements the shared managed Git worktree variant, format-3 provenance, reviewed new-path trust and guarded cleanup; see [worktree operations](../architecture/desktop/worktrees.md). Full packaged Desktop acceptance and Windows shared control remain delivery gates. Attachment joins an established owner; live foreground transfer is not supported. They govern the overlapping scope of the [workspace implementation plan](workspace-execution-implementation-plan.md) and [Desktop implementation plan](desktop-implementation-plan.md). Change this document and both affected plans together when revising a decision.

## 1. Decisions and boundaries

1. Workspace identities, execution targets, environment leases, and execution ownership belong to the core runtime. Desktop projects and invokes them; it does not create a competing registry or scheduler.
2. A source workspace, a working target, an environment instance, and an execution owner are different identities. None grants authority merely by existing.
3. Extend the existing profile-bound gateway supervisor to host shared interactive sessions, Tasks, cron, and channel execution. A profile has at most one live shared supervisor. Channels may be disabled; shared execution does not require Telegram.
4. `DesktopControlService` is a profile-bound client bridge and setup/projection service. Electron owns its lifetime. It does not own shared agent execution, poll channel adapters, or run another Task/cron scheduler.
5. Preserve daemon-free foreground CLI and ACP operation. All execution entry points use the same persisted session ownership checks, including when no shared supervisor is running.
6. One process owns an executing session at a time. Task host/attempt leases remain canonical for Tasks; session ownership additionally prevents another surface from running that same executor session.
7. Attachments grant an authorized surface access to a session, not execution ownership. Handoff transfers ownership only at a settled boundary. No live stack, shell, or provider stream migration is promised.
8. Desktop-to-child traffic remains private stdio. Reconnecting to the independently running supervisor uses authenticated private local IPC, never a localhost HTTP server or renderer-accessible endpoint.
9. This is a local operator trust model, not isolation from malicious processes running as the same OS user and not a multi-tenant hosting design.

## 2. Shared workspace and target contracts

Keep the existing path identity shape and hashing semantics for compatibility:

```ts
type WorkspaceIdentity = {
  canonicalPath: string;
  identityHash: string;
};

type TaskWorkspaceBinding = WorkspaceIdentity;

type SourceWorkspaceBinding = {
  identity: WorkspaceIdentity;
  registeredWorkspaceId?: string;
  registeredWorkspaceRevision?: number;
};

type ExecutionTargetBinding = {
  targetId: string;
  targetGeneration: number;
  // The actual local working root, preserving existing Task workspace semantics.
  workspace: WorkspaceIdentity;
};
```

These shapes describe shared semantics. PR 1 serialized workspace records, targets and target bindings use `schemaVersion: 1`; Session/Task persistence adds bindings in Session schema 33. Later shapes still require explicit versions and validation in their implementation PR. The current path hash identifies a canonical path, not repository contents, an OS directory object, or a security sandbox.

| Concept | Meaning and owner | Lifetime/change rule |
|---|---|---|
| Registered workspace | Optional profile-local ID, alias, source path identity, and location revision | Alias changes preserve identity; root changes require a new location revision and authorized selection |
| Execution target | Profile-owned record of the working location, source snapshot, kind, generation, status, and applicable provenance | The selected root/source binding is fixed; replacement creates a new target |
| Environment lease | Prepared file/search/inspection, command/code/process, and artifact-transfer capabilities | May be reacquired after current verification; never treated as a durable authority grant |
| Execution scope | Session/Task/attempt/child ownership of cancellation and resources | Releasing one scope cannot destroy another scope's resources |
| Session execution owner | Persisted process ownership and fencing generation for a session | Changes only through checked acquisition, release, or recovery |

Core target records include `profileId`, `id`, `kind`, `generation`, `source`, `workspace`, and lifecycle status. Use discriminated variants for local directories, managed Git worktrees, and temporary copies as each gains a live consumer. Worktree records carry repository/common-directory identity and creation/cleanup ownership. Copy records carry source-manifest and baseline references. No placeholder Remote kind is exposed.

### Source versus execution identity

- A local target has the same source and working directory identity.
- A worktree target retains its source repository reference but its `workspace` is the worktree root. Existing Task `workspace` and Session workspace metadata continue to describe that working root, not the parent checkout.
- A temporary-copy target has an explicit source snapshot and its own working root. Copy creation and application use the source manifest and destination authority separately.
- Host versus Docker is environment policy, not target kind. A local/worktree target may use either supported backend. A container path such as `/workspace` is an environment handle; it never replaces the host identity in legacy Task fields.
- All model-visible workspace tools and Desktop file/diff inspection use the selected target's lease. Human PTYs use separately owned, verified target capabilities; setting `cwd` is not filesystem confinement.
- Artifacts preserve both execution provenance and any source/application destination references. Extend the existing artifact store and Task Results rather than creating Desktop-only artifact ownership.

### Selection, generation, and migration

1. `cd project && estacoda` requires no named registry entry or extra prompt. Core code may create/reuse a profile-owned local target record during authorized session creation. Reuse requires matching canonical identity and current verification; naming a workspace remains optional.
2. Session and Task creation atomically records the target binding and compatibility workspace snapshot. Resume, runtime construction, channel attach, checkpoint recovery, and executor creation all validate profile and target ownership through the same core path.
3. Target ID, working-root identity, and source binding are immutable for a Session/Task. A compatible generation refresh follows rule 6. Picking another workspace affects new work only. Moving active work to a different target requires an explicitly supported, authorized fork/recovery operation with recorded lineage; never overwrite the original identity binding.
4. Renaming a registry alias does not change target generation. Moving its source path advances the registry location revision. Existing targets and channel bindings do not follow the alias to the new path; they remain historical or become unavailable. An authorized selection creates a new target binding.
5. A target generation advances for readiness/identity invalidation or lifecycle transitions that can make a previously issued target operation stale. UI labels and verification timestamps do not advance it. An identity replacement is a new target, not a generation bump that silently rebinds sessions.
6. Every target-sensitive mutation supplies the expected target generation. Resume revalidates a stale binding and either explicitly adopts the compatible current generation while preserving the root/source binding, or returns a blocker. A changed generation alone does not require renewed authority; authority is compared independently.
7. Target generation, runtime build key, environment verification generation, execution-owner fence, and authorization generation are distinct. None substitutes for another. Reusable approvals do not bind to incidental cache/health timestamps.
8. Only core registry/target code writes records. Use existing profile-path helpers and concurrency-safe storage; do not let Desktop maintain a second path-to-ID mapping. Coordinate target registration and Session/Task persistence with validated references and recoverable creation, not an assumed cross-file transaction.
9. Legacy Task fields remain readable. Bind a legacy Session only when its existing authorized local flow establishes profile and working-root ownership. Ambiguous remote records fail closed. Migrations and older-version readers must not discard ownership fields or reinterpret unknown bindings as unrestricted access.
10. Archive marks a target unavailable for new work; deleting owned backing files is separate. Refuse physical cleanup while execution/inspection/PTY borrowers remain, preserve dirty worktrees, and retain historical references. Losing a copy or worktree produces a recovery blocker, not silent execution against its source checkout.

## 3. Process topology and private control transport

```text
Desktop renderer -> preload -> Electron Main
                                  |
                     private stdio + credential pipe
                                  |
                       DesktopControlService
                                  |
                      authenticated local IPC
                                  |
                  existing profile-bound supervisor
                    /          |              \
            session host   Task/cron hosts   ChannelGateway
                    \          |              /
                       runtime coordinator
                         target + environment

Foreground CLI / ACP -> same coordinator + persisted session ownership
                     -> supervisor client when attaching shared execution
```

### Shared host discovery and startup

- Reuse the existing supervisor, service-manager, and profile discovery machinery. Add an authenticated control endpoint and shared-session hosting there; do not create a second desktop daemon or install a duplicate login service.
- Use a Unix-domain socket on macOS/Linux; Desktop initially ships on macOS. Windows shared-control support needs an equivalent protected named pipe before advertising that capability. Existing foreground workflows remain available without the endpoint. The transport carries the versioned semantic control protocol; the renderer never receives endpoint credentials or raw transport access.
- Protect discovery and endpoint state with profile-local ownership, restrictive directory/file permissions, symlink checks, and a fresh supervisor-instance authentication secret. Verify peer identity where the platform supports it and bind requests to the initialized profile and instance. A path, PID, profile name, or caller-supplied channel identity is not authentication. Never log the secret or pass it through argv or model context.
- Harden singleton acquisition before enabling this endpoint. An old timestamp or failed IPC request cannot justify stealing a lock from a still-live process. Validate instance identity and use serialized claim/cleanup so concurrent Desktop launches cannot start two supervisors or unlink a successor's endpoint.
- Desktop can bootstrap and edit setup without a running execution host. Starting Work may start an on-demand supervisor through the existing launch path; this does not install a login service, enable a channel, or mutate the active-profile pointer. Persisting execution across logout/reboot requires the existing explicit service-install choice.
- Reuse an already installed/running compatible supervisor. A version/schema mismatch produces repair/restart guidance; do not silently launch a second host or rewrite shared state with an older binary.
- Shared execution outlives a bridge connection. Multiple windows may have separate bridges to one profile supervisor. Configuration apply remains profile-bound and must coordinate concurrent writers and notify/invalidate the shared runtime through reviewed core paths.
- Credential candidates remain in the bridge's isolated staging path until reviewed apply. Ordinary supervisor control traffic carries references/status, never staged raw values. On receipt of a config revision, the host re-resolves credentials and authority through existing core resolvers.

### Authority and control routing

The authenticated local operator can request supported operations through narrow methods. The service derives caller/profile/window context from its connection; the renderer cannot claim another surface's authority. Channel input is authenticated by `ChannelGateway` before becoming a normalized execution request.

For channel-originated approvals and continuations, Desktop calls a narrow operator method implemented by `ChannelGateway` in the supervisor. It must not forge a Telegram message, resolve queue rows directly, persist grants itself, or invalidate the gateway's caches itself. The gateway performs scoped resolution and continuation handling. Local approvals use the existing approval controller and Task approval services under the execution owner. The common durable queue remains storage, not a second orchestrator.

Connecting a window, displaying an approval, or opening a terminal confers no new grant. A human-input API is still a renderer capability; sender validation and isolation of sensitive UI remain required by the Desktop threat model.

## 4. Session ownership, dispatch, and handoff

Add narrowly scoped session execution ownership metadata to the existing Session database. Do not introduce new Work/Run/Step lifecycle databases. At minimum, records bind profile/session, target ID, owner instance ID, fencing token, heartbeat/expiry, and current turn/control revision. The precise schema and atomic compare-and-set operations ship with workspace PR 4.

### Acquisition and execution

1. Resolve immutable session/target ownership and current governance before acquisition. Atomically claim an unowned eligible session; only its owner can start a provider/tool turn or append authoritative execution transitions.
2. A supervisor can own many sessions. Foreground CLI/ACP may own a local session without a supervisor. The same session cannot be active in both. A client observing a foreign live owner attaches to the shared owner where supported or receives an actionable busy/handoff response.
3. Serialize concurrent runtime acquisition for one owned session. `RuntimeCache` is a process-local performance optimization, not execution authority. Cache hits, invalidation, and eviction cannot acquire, transfer, or revoke session ownership by themselves.
4. Task host and attempt leases remain prerequisites for Task dispatch. Acquire in a documented order: Task host grant, attempt lease, then executor-session ownership, unwinding on failure. Interactive roots take session ownership only. Distinct child executor sessions can run concurrently; children never acquire their parent's execution session as another writer.
5. Check the current owner fence and authorization immediately before dispatch and authoritative result settlement. Target/authority invalidation fences new actions and cancels owned operations. Do not hold a SQLite transaction across provider or tool I/O. Finalization, delivery, and UI projection services retain their existing separately authorized writes; they cannot use those writes to impersonate the active executor or bypass owner-fenced execution transitions.
6. Renewal failure stops dispatch and signals cancellation. Fencing prevents stale runtime writes/dispatches; it cannot recall an already issued external request or stop an arbitrary shell solely through a database token. Terminate owned process trees through the environment lease and preserve uncertain effects.

### Inputs and idempotency

- The owner serializes normal inputs to a session. Accepted input is bound to profile, session, target, authenticated origin, and operation identity before acknowledgement. It never follows a subsequently changed workspace selector.
- Extend existing pending-turn/checkpoint/control records for accepted commands and receipts. Do not create parallel Telegram/Desktop transcripts or treat transient notifications as the queue. Preserve channel-specific deduplication and uncertain-message recovery.
- Scope `operationId` by profile, authenticated principal, and method. Bind it to the canonical request; reuse with different input is a conflict. Persist acceptance/terminal receipts for retryable mutations so a lost response is distinguishable from a request never accepted. Define bounded retention and return expired/unknown rather than rerun an old accepted mutation blindly.
- Persist sensitive user text only through the existing appropriate bounded session/pending-input store. Receipts contain references and safe metadata, never raw credentials or secret-derived hashes.
- Cancel, stop, approval resolution, and denial are control operations, not ordinary queued prompts. Service them through a bounded priority path while a turn waits. Guidance is applied at a supported boundary; cancellation requests are acknowledged separately from confirmed termination.
- Deduplicating control requests does not establish exactly-once external effects. An operation dispatched before a crash is reconciled against evidence/provider receipts, or remains uncertain and needs intervention.

### Handoff and recovery

- Desktop and Telegram views of a supervisor-owned session attach to the same owner; this requires no execution transfer. Handoff codes retain existing authorization, expiry, and replay protections.
- A foreground CLI/ACP session transfers to the supervisor only when its active turn is settled and owned commands are stopped or explicitly recoverable. The old owner persists its checkpoint, releases ownership with the current fence, and the supervisor atomically acquires a new fence. Only then acknowledge shared continuation. If transfer fails, keep durable state and report owner/unavailable status; neither side resumes optimistically.
- Unsupported unsaved ACP buffers, live PTYs, browser control, or in-flight mutations block transparent transfer with a concrete reason. Do not assume a checkpoint captures those resources.
- A failed heartbeat or elapsed TTL alone is not proof the old owner stopped executing. Recovery verifies prior instance death or acknowledged quiescence and reconciles owned resources. If the instance may still be active, expose attention instead of dispatching a competitor. PID reuse requires instance-aware checking; wall-clock jumps and sleep cannot authorize takeover.
- On recovery, revalidate profile, target, trust, current grants, definition compatibility, and resource health. Reconcile dispatched/uncertain operations before retry. Reuse the existing checkpoint/operation journal and Task fencing mechanisms.
- Late results from a fenced owner cannot mark current work complete. Preserve a bounded diagnostic or reconciliation receipt where useful; they do not authorize another side effect.

## 5. Lifecycle behavior visible to operators

| Event | Required behavior |
|---|---|
| Close a Work view or Desktop window | Detach subscriptions; shared work continues within its existing lifetime/budget |
| Quit Desktop | Dispose bridges, staged secrets, and Main-owned PTYs; supervisor-owned work continues |
| Switch Desktop profile | Clear bridge/Main/renderer state and candidates; leave the old profile's shared work running; reconnect only to the selected profile |
| Bridge or renderer crashes | Supervisor retains execution ownership; reconnect using canonical snapshots and operation receipts |
| Foreground CLI exits | Stop its active turn, settle/checkpoint and release ownership; independently leased background Tasks retain their documented continuation behavior |
| ACP disconnects | Cancel/release editor-owned foreground work safely; unsaved buffers are not transferred implicitly |
| Explicit stop/cancel Work | Route to the execution owner; report requested versus completed cancellation and uncertain side effects |
| Explicit supervisor stop/restart | Drain or cancel under existing lifecycle policy; release only settled owned work; restart recovers eligible persisted work |
| No windows and no work | An on-demand host may exit once no active Tasks, turns, pending continuations, enabled schedules/channels, or clients require it; an installed service follows its service-manager policy |
| Machine sleeps or shuts down | No execution-availability promise during sleep/offline time; after wake/restart apply ownership and uncertain-operation recovery |

An on-demand supervisor runs independently of Electron's process cleanup. Its launch, executable ownership, shutdown, and package-uninstall behavior must be tested in the signed app. No automatic operating-system service installation is implied by closing a window.

Main-owned PTYs are ephemeral human resources with a separate owner. Their target capability is revoked on window/profile change or loss of the verified control connection; close them rather than letting stale target access persist. Shared agent command processes remain environment/scope-owned. Browser view subscriptions do not acquire human control.

## 6. Delivery ownership and prerequisite gates

| Delivery slice | Responsibility |
|---|---|
| Workspace PR 0 | Record baseline and this decision; characterize cache races, supervisor singleton behavior, and cross-surface session ownership |
| Workspace PR 1 | Shared identities, optional registry, local target records/bindings, common attach/resume ownership validation and migration |
| Workspace PR 2 | Scoped grants, live authority revisions, and revocation rules distinct from target/owner generations |
| Workspace PR 3 | Complete host environment lease, owned resources/cancellation, and inspection contracts |
| Workspace PR 4 | Session execution ownership, serialized acquisition, shared supervisor session hosting, authenticated local endpoint, minimal send/cancel/approval control receipts, and recovery |
| Desktop architecture/Work proof | Consume the above core contracts; add bridge, secure shell, projections, and packaged lifecycle proof; no duplicate target or execution stores |
| Workspace PR 5 + Desktop Telegram slice | Channel selection, authorized shared attachment, local operator approval routing, and cross-surface continuation tests |
| Desktop worktree slice | Implement core Git worktree target variant and lifecycle, then expose selection/inspection UI; workspace plan consumes it rather than claiming existing managed support |
| Workspace PRs 6–8 | Docker parity, temporary-copy target/application, and consolidated execution release gates |

Workspace PR 4 should be split into reviewable implementation PRs if needed while preserving this dependency gate. The shared protocol's minimal host methods must be usable by CLI/control clients without Electron; Desktop adds its projection/setup methods as they gain consumers. Do not generate the entire future method catalog before the first usable flow.

A small Desktop proof may use an existing configured profile and local target after workspace PRs 0–4. It need not wait for Docker, managed worktrees, or the complete Models/Connections UI. Fake-runtime UI development can proceed earlier, but cannot satisfy the real ownership gate.

## 7. Required conformance cases

1. Two concurrent launches for one profile yield one supervisor; an old lock timestamp, malformed discovery file, socket failure, PID reuse, or sleep does not authorize takeover of a live owner.
2. Two windows and Telegram submit to one session: accepted operations are serialized/deduplicated and one owner executes. Separate sessions still run concurrently.
3. CLI and shared-host acquisition race for the same session: exactly one claim succeeds; the loser neither starts a provider request nor appends competing execution transitions.
4. Start shared work in Desktop, attach Telegram, close Desktop, resolve approval remotely, reopen Desktop: one continuation and consistent canonical history. Repeat resolution from Desktop and verify Telegram delivery through the gateway.
5. Profile switch leaves existing shared work running but exposes none of its state, candidates, PTYs, or control handles in the new window. Forged IPC profile/surface fields and cross-profile IDs are rejected.
6. Crash before acceptance, after acceptance, during tool dispatch, after external mutation, and after durable settlement but before reply: receipts and evidence determine recovery; uncertain mutations are never blindly replayed.
7. Kill or stall an owner and deliver a late result: new dispatch waits for verified recovery, stale fences cannot settle work, and owned process cleanup cannot kill another scope.
8. Alias rename, source move, target archive, worktree replacement, copy loss, and symlink changes do not retarget active work or transfer trust/grants. File/diff/command/code views agree on the selected target.
9. Task host, attempt, session, and environment acquisition failures unwind without leaked processes or orphaned ownership. Releasing a viewer cannot release the execution owner's lease.
10. Saturate notification/output queues while issuing stop or deny: bounded control traffic remains responsive; reconnect uses a snapshot/cursor boundary without missing canonical changes.
11. A foreground CLI/ACP handoff with unsaved content or live non-transferable resources is refused clearly; a settled handoff preserves lineage and cannot create two active owners.
12. Packaged Desktop quit/relaunch, compatible CLI attachment, explicit supervisor restart, and incompatible binary/schema detection preserve the documented lifetime and ownership rules.

Run focused integration tests for these cases as their behavior ships, followed by each plan's release validation. The current planning change requires link/contract consistency and whitespace checks only; it does not implement or validate these future guarantees.

## PR 4 implementation boundary

Core Session claims/fences, singleton acquisition, Unix private control, durable operation receipts, current runtime authority and compatible checkpoint recovery are implemented. See the [implementation record](workspace-execution-pr4.md) and [runtime operations](../operations/runtime-ownership.md). Cancellation acknowledgement is explicitly not termination confirmation. Foreground transfer currently means settled disposal followed by explicit acquisition, never live resource migration. Direct skill-file edits load on reconstruction. On-demand startup uses the existing supervisor/service ownership; it does not add idle shutdown or automatic service installation.

The conformance list above spans this core slice and later consumers. Signed Desktop lifecycle, multi-window/channel attachment and profile switching need the Desktop/PR 5 integration proof; Windows needs protected named pipes. Those cases are not claimed as locally validated by the core tests. No Electron scheduler or duplicate execution database was introduced.
