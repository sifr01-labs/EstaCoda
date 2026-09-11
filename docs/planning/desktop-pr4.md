# Desktop PR 4 implementation record

Branch: `ame/desktop-foundation`. Eight planned slices; implementation in progress.

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
