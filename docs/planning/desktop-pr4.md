# Desktop PR 4 implementation record

Branch: `ame/desktop-foundation`. All eight planned slices implemented and reviewed.
A subsequent PR3/PR4 review correction supersedes the historical limits below; see [the correction record](desktop-pr3-pr4-corrections.md).

## 1. Session Work projections

The bridge exposes `work.list`, `work.get`, and `work.activity` from the selected
profile's canonical SQLite state. Read-only capture does not run migrations,
create state, acquire execution leases, or instantiate a runtime. Work identities
retain canonical Session IDs and optional parent references. Outcomes come from
canonical final-outcome records, not assistant prose. Transcript projections omit
raw tool arguments/results and redact displayed text.

Bootstrap replaces the materialized snapshot and all page tokens. Tokens are
opaque and bound to the bridge, epoch, query and page size. Replies have a byte
budget in addition to item limits. The alpha capture currently refuses profiles
over 1,000 Sessions, transcripts over 1,000 messages, or snapshots over 8 MiB;
it returns snapshot-required instead of silently truncating the Work list.

Validation: focused snapshot, subscription and bootstrap tests (8 tests) passed.
Security review: reads are profile scoped; capture uses a read-only connection;
no new execution or approval authority is exposed in this slice.

## 2. Task and run projections

Tasks use the existing profile-bound Task store and operator projections. Root
Tasks group beneath their user-facing origin Session; independent operator Tasks
remain roots. Attempts retain their own identities beneath Tasks. Internal host
and worker Sessions are omitted from navigation. Plans and bounded result
summaries are available through Work activity. Result availability does not
assert verified external effects, and unavailable cost remains null.

Validation: three canonical SQLite snapshot/pagination/grouping tests passed;
clean-copy typecheck passed. No Task lifecycle writes or new scheduler were added.

## 3. Session lifecycle and generation fencing

Session start creates a canonical, trusted target-bound Session reference with an
operation binding; resume validates that reference. Send/cancel/start/resume and
inspection use the existing authenticated supervisor client and on-demand host
startup path. The bridge never constructs an agent. Supervisor capability probes
now explicitly report generation support; Desktop refuses incompatible hosts.

Generation is included in canonical receipt payload identity and returned from
that persisted binding. New receipt acceptance checks the Session generation;
the supervisor revalidates the target before execution. Exact retries return the
original receipt, including after the normal acceptance window. Cancellation
remains a request, not proof that external work stopped. Existing generationless
CLI controls retain their previous semantics.

Validation: 57 protocol/receipt/host tests and seven local socket/process tests
passed; clean-copy typecheck passed. Security review covered profile/target
mismatch, missing enforcement, conflicting retries and stale generations.

## 4. Task lifecycle and guidance

Desktop Task controls are dispatched by the supervisor to TaskOperatorService
and FixedTaskService. They require the exact origin Session and Task target
binding. Core retry eligibility, attempt budgets, terminal-state restrictions,
and guidance limits remain authoritative. Task IDs, optional Step IDs and guidance
are included in canonical operation payloads; inspection remains profile scoped.

Validation: 58 protocol/receipt tests, a real SQLite Task lifecycle and authority
regression, clean-copy typecheck, and Desktop foundation checks passed. Controls
write canonical state; they do not acquire scheduler or worker ownership.

## 5. Durable Desktop approvals

Shared Desktop turns persist pending requests in GatewayApprovalQueue with exact
profile, Session, target generation, risk class and pending-action authority.
The supervisor retains the live continuation; reopening Desktop reads the same
row. Resolution consumes the queue row once, then the owning runtime revalidates
and grants once before continuation. Denials and cancellation settle the wait.
Expiry uses the existing queue wait path. A supervisor restart expires orphaned
Desktop continuations; it never replays an uncertain action.

Task approvals route to TaskApprovalService; channel approvals continue through
ChannelGateway's local-operator method. Desktop neither persists reusable grants
nor mutates channel continuations. Stop/deny controls remain reachable after
workspace trust revocation.

Validation: 31 existing host/queue/Task-approval tests, one new durable
reconnection/exactly-one-continuation regression, and clean-copy typecheck passed.
Security review covered authority/target binding and claiming a pending resolution
before asynchronous grant work. Runtime grant checks remain the final authority.

## 6. Inbox and canonical change notifications

Inbox now projects durable approvals, Task input/host waits, failed/partial Work,
uncertain receipts, missing model/credential state, OAuth expiry, supervisor
connection problems, workspace trust, failed schedules, Evolution proposals and
Task/schedule delivery failures. Approval actions contain only an exact reference,
summary and once/deny choices. Raw command payloads, fingerprints, credentials and
proposal patches are not exported.

Profile files are selected by backend paths and bounded reads; linked profile
state is rejected. Credential inspection does not load `.env` into process.env,
refresh tokens or contact a provider. Schedule executions group beneath their
profile-owned schedules. Work and Inbox changes use the bounded subscription
journal; canonical polling is every five seconds, with no overlapping captures.
Rewritten activity/deleted Work requests a fresh snapshot instead of inventing
an append event. Existing page tokens continue to refer to their original epoch.

Validation: eleven focused projection, profile isolation, notification,
subscription and bootstrap tests and clean-copy typecheck passed. The protocol
capability expectation was updated for the lifecycle handlers now implemented.

## 7. Grouping and status regression review

Added semantic coverage for terminal outcomes, live ownership, Task waits,
interrupted Attempts, child/independent Task grouping, new turns after success,
and colliding cross-profile schedule IDs. Review corrected three edges: new
turns no longer inherit prior completion, Task controls survive ended origin
Sessions without taking a Session lease, and run projection requires a
profile-owned Session rather than trusting a schedule identifier alone.

Session activity now includes allowlisted tools, plans and canonical outcome
records. SQL selects display fields rather than buffering raw tool payloads.
Event histories are bounded at 1,000 display events per Session, with explicit
snapshot-required on overflow. Missing usage/cost remains unavailable; priced
Task totals come from canonical accounting. Capture byte accounting is linear,
and repeated workspace trust checks are cached within one capture.

Validation: 64 focused protocol/projection/Task-control tests passed; the prior
expanded socket/process regression passed 98 tests. Clean-copy typecheck passed.

## 8. Approval rejection and process lifecycle proof

A real Node Desktop child process starts a Session, sends to a shared fake runtime,
disconnects at its durable approval, and reconnects through a new process. The
new client reconstructs Inbox, rejects forged IDs, wrong Sessions and stale
generations, approves once, and inspects/retries the original operation without
redispatch. Additional queue tests reject cross-profile/cross-session resolutions,
hardline requests, stale-generation rows and expiry.

Review tightened pre-acceptance checks for Desktop approval references. An exact
previously accepted operation remains inspectable; a new operation cannot claim
an already consumed approval. Durable Task approvals, like Task lifecycle
controls, can be resolved after their origin Session ends while retaining Task
scope and target checks. Ordinary Session controls keep their ownership checks.

## Final validation

Validated the exact executable source in an isolated clean copy, excluding the
operator checkout's pre-existing untracked duplicates. No dependency or lockfile
change was needed. Node v24.14.1; pnpm 10.33.0.

- `desktop:foundation:check`: both workspace typechecks and pure import boundary passed.
- `validate:execution-release`: complete host/Docker wrapper passed.
- Frozen install, root typecheck and conformance inventory check passed.
- Full suite: **10,783 tests / 652 files passed** (two workers).
- Source smoke and dist smoke: all 13 cases passed in each run.
- Build, runtime-import audit and ESM audit passed.
- Execution budget fixture gate passed with PR0 call/token ceilings preserved.
- Source and dist Docker parity, containment, cancellation, copy/apply/rollback,
  CLI/channel/recurring execution, ownership and missing-image refusal passed.
- Docker image build/validation passed.
- Executable source comparison against the validated copy had zero mismatches;
  final patch hygiene passed.

The first wrapper attempt inherited Git location variables into temporary-repo
tests, and one Bun interoperability test timed out under full parallelism. The
harness was corrected to use its own Git metadata and two workers; the working
repository location/commit identity were restored before rerunning. The final
complete wrapper above passed without changing product behavior for those failures.

## Limits and risk note

This is the Desktop backend foundation, not the signed Electron delivery gate.
The process test uses a fake provider/runtime; it proves transport, durable state,
ownership and control behavior without live provider calls. Persisted activity is
polled every five seconds; token streaming is not claimed. Snapshot size/history
bounds above remain explicit alpha limits and do not certify large-profile scaling.

Security-sensitive changes are confined to canonical projection reads, trusted
supervisor controls, receipt identity and the existing approval queue. Hardline,
trust, profile isolation, once-only grants and owner-held continuations remain
mandatory. PR5 still owns Electron isolation and the approved visual contract.
