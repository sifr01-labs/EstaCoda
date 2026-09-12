# Desktop Work

Desktop is a client of the execution supervisor. Closing the app, switching profiles or reconnecting the bridge does not transfer execution ownership to Electron. Work, attempts, approvals, outcomes, provider usage and model selections are canonical core records.

## Starting and navigating Work

The Work list offers conversation, Task and active filters over its explicitly loaded extent. Search queries canonical title, workspace label and identifier metadata, including items outside the current page. It does not search transcript contents. Search and child navigation stop at 2,000 loaded results and use snapshot-bound cursors. Pins store at most 100 references per selected profile in desktop presentation storage; their labels and state are resolved from core.

New Work selects an existing trusted target. Target registration and trust remain CLI operations at this milestone; managed worktree creation is PR9. A draft can start a conversation or a durable background Task. The Task review drawer exposes execution limits that can only narrow operator defaults, explains authority, and requires explicit review. Terminal execution and child Tasks remain blocked by that Task policy; workspace writes require approval and profile spending limits apply.

The composer preserves text, target, model and attachment handles while navigating and changing appearance. Profile changes clear drafts. Its right-hand model control selects the new Work route or requests an existing Work override at the supported turn/attempt boundary.

## Attachments

The native picker stages actual immutable file contents in Main, not filenames as pretend inputs. Supported inputs are regular UTF-8 text/source files from the explicit extension allowlist, at most four files per prompt and 8 KB per file. Symlinks and binary inputs are rejected. Main holds at most 64 handles for 15 minutes, bound to the profile, connection generation, target generation and draft. Reconnect and profile changes invalidate handles; the composer asks the user to reattach when necessary.

Submission contains the prompt plus a bounded JSON representation of the selected file contents, labelled as untrusted input. The combined bound is 32,768 characters/60,000 UTF-8 bytes; a new Task objective including attachments must fit 4,000 characters. These inputs grant no tool, filesystem or execution authority. The renderer receives opaque handles and safe metadata, never picker paths. Artifact retention and binary/document extraction are not supplied by this attachment flow.

## Activity, decisions and recovery

The selected conversation reads a bounded ephemeral assistant preview from the existing owner once per second, with one read outstanding. The preview resets at tool boundaries and settlement. Canonical history supplies assistant messages, safe tool activity, plans and outcomes; it refreshes even if an event does not advance the Work timestamp. Parent/child navigation includes delegated Sessions and Task worker attempts, with child workers inspection-only.

Stop, pause, resume, retry, guidance and approval choices follow backend capability hints and are revalidated by core. Approvals expose only approve-once and reject. A control receipt means a request was accepted or settled; it does not mean the Work completed or external effects succeeded. Cancellation remains requested until canonical termination is known.

Main writes bounded, reference-only operation pointers before dispatch. After an uncertain reply or restart, it inspects the same canonical operation rather than automatically resending the prompt or decision. Completed reference groups may be evicted under the journal bound; unresolved references are retained. The journal contains no transcript, attachment contents, credential or approval grant.

Inbox filters attention categories, opens off-page Work and supports return/next-request navigation. Provider setup requests open Models & providers. Repair and governance items without an implemented desktop action expose their existing repair path rather than simulating a mutation.

## Usage and status

Usage comes from the core provider ledger, including verified Session compression lineage and originating Task spend. Inspection is bounded to 4,096 ledger entries and 128 root Tasks; truncated totals are labelled lower bounds. Missing tokens, pricing and context are unavailable, and active Work totals are provisional. Context invalidation clears the previous reading.

The status bar separately counts running root Sessions, running Tasks, approvals and active schedules. It does not count child workers or attempts twice, and does not equate approvals with commands. Disconnection makes counts unavailable. A cached execution lease does not override a recorded completion outcome. Target directory identity and requested execution policy do not prove sandbox isolation.

## Trust review

The Main API accepts semantic intents and opaque references. Main owns operation IDs and draft-to-Session/Task mappings. Core rechecks selected-profile membership, workspace trust, target generation, lifecycle eligibility, hardline policy and approval scope. The desktop does not write canonical execution records or adopt a supervisor. Tests cover stale profiles/targets, unsafe attachments, uncertain dispatch, duplicate decisions and restart inspection.
