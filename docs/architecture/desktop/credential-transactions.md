# Desktop credential transactions

Status: design requirement, Desktop PR 1. Candidate staging/transport ships in PRs 3/5, Models apply in PR 6, and Telegram apply in PR 8. No new secret persistence exists in this PR.

## Owners and channels

The ordinary renderer requests a credential-entry operation, but never receives the secret. Main opens a dedicated local-only credential window, validates that window's sender/frame, and forwards its bounded submission through a separate non-logged child pipe to the profile-bound bridge. A general `send(channel, payload)` API is forbidden. The credential window has no transcript, remote content, ordinary app API, persistent browser storage, production DevTools, or generic navigation.

The bridge stores candidates only in memory until reviewed apply. Bind a candidate to an opaque random ID, selected profile, purpose (provider/Telegram), exact provider and auth mode/endpoint, requesting window, bridge instance and transaction generation. Main supplies identity context; renderer fields cannot override it. General RPC carries opaque IDs and safe status, never raw candidate values. Candidate IDs are not execution grants and are excluded from logs/diagnostic exports.

Initial bounds for implementing PRs: five-minute idle expiry, fifteen-minute absolute transaction expiry, at most eight candidates per window and 32 per bridge, 64 KiB maximum encoded submission, and bounded verification concurrency of one per transaction. OAuth additionally respects provider expiry. Validate byte length before decoding/allocating unbounded input. Clock changes cannot extend the absolute monotonic deadline. Changing purpose, route, endpoint, window, profile or bridge invalidates the candidate and requires a new review.

## State machine

| State | Allowed next action | Persistent effect |
| --- | --- | --- |
| Empty | Collect API key or start service-owned OAuth flow | None |
| Staged | Verify exact candidate against bound route | None |
| Verifying | Success → verified; failure/cancel/expiry → discarded | None; verification may contact the explicitly selected provider under its bounded policy |
| Verified | Construct safe draft and review | None |
| Reviewed | Explicit Apply with current revision and single-use transaction identity | None until commit boundary |
| Applying | Serialize against other writers, revalidate scope/review/expiry/revision, perform reviewed core apply | Only reviewed files/actions |
| Applied | Discard candidate; read-only verification; expose safe result | Applied configuration/credential remains, including when post-apply verification fails |
| Discarded / expired / conflicted | Start a fresh transaction | No pre-commit writes; no candidate reuse |

UI close, profile switch, bridge shutdown and cancellation invalidate the generation and cancel pending verification. Late verification/OAuth callbacks must check that generation before creating a draft or applying anything. A candidate permits multiple bounded read-only verification attempts only within its lifetime; consuming it for apply is single-use. Failed verification in the initial flow discards it, so retry collects a new candidate.

An Apply request races with cancellation at a defined commit boundary: cancellation accepted before commit leaves config/credentials unchanged. After commit starts, do not report “cancelled, nothing saved”; return applied, failed with recoverable state, or unknown and reconcile the operation. Switching the UI profile cannot redirect an already committed transaction into another profile. Reconnect queries a safe apply receipt; it never blindly repeats a credential write under a new operation ID.

## Reviewed apply and recovery

Reuse [reviewed setup execution](../../../src/setup/review/apply-executor.ts), [setup planning](../../../src/setup/setup-apply-plan.ts), [profile path resolution](../../../src/config/profile-home.ts), [API-key storage](../../../src/config/env-secret-store.ts), and [OAuth storage](../../../src/providers/oauth/oauth-store.ts). Explicit selected-profile parameters are mandatory. API keys resolve through profile `.env` references; OAuth goes to profile `auth.json`; `authMethod: none` needs no candidate. Workspace trust never loads project config or shares credentials between profiles.

The shared setup executor applies operations, deferred secrets and OAuth in separate steps. Desktop PR6 wraps it in [recoverable profile Apply](../../../src/setup/review/profile-apply.ts), serialized with [the profile writer lock](../../../src/config/profile-write-lock.ts). A durable restricted journal commits the reviewed snapshot; activation stays blocked until interrupted file replacement is recovered. Per-file rename is not cross-file atomicity. PR8 reuses this boundary; do not build a second Telegram transaction engine.

Required proof: serialize profile writers, reject stale reviewed revisions before writes, preserve unrelated settings, stage restricted files only after authorized Apply, recover an interrupted multi-file commit before the new route becomes runnable, and retain enough safe receipt state to distinguish not-started/applied/uncertain. Any recovery files containing credentials have the same permissions/profile scoping as the secret store, never ordinary logs or receipts. Do not expose partial config as ready; on recovery failure, block affected route activation and surface repair. This does not authorize changing core persistence or implementing a transaction subsystem in PR 1.

Pre-commit blocked/cancelled flows write no secrets or config. After the commit point, errors require truthful recovery and cannot promise zero writes. Post-apply verification is read-only; failure is “saved, verification failed,” not silent rollback or success. Notify the supervisor of a committed config revision through reviewed core invalidation; the bridge never restarts an executor or edits its prompt mid-turn itself.

## OAuth and provider verification

Keep OAuth exchange, state and tokens in the service. Expose only a validated verification URL, user code, expiry and bounded status. Do not reuse any helper's persistence side effect before Apply. Main opens only the expected provider's safe URL in the external browser; reject arbitrary schemes, redirects/hosts and embedded credentials. Drop polling and late results on expiry/cancel/profile switch. Successful OAuth tokens remain staged until review and Apply.

Verification binds the candidate to the selected provider/endpoint and never retries against another endpoint with the same secret. Apply existing URL/private-network policy and explicit local-provider setup rather than treating a localhost endpoint as universally permitted. Verification shows scope and any potential spend, has bounded timeout/request/token limits, and returns safe results, not provider bodies or raw request dumps. Telegram validation checks bot identity without sending a chat message; outbound test messages require a separate explicit action.

## Required tests and limits

PRs 3/5 test dedicated sender/pipe isolation, bounds/TTL, disposal, stale callback rejection, and canary values absent from RPC/events/logs/browser state/crash diagnostics. PRs 6/8 test cancellation at every pre-commit state, wrong profile/window/purpose, duplicate Apply, concurrent writers, revision conflict, interruption between each file write, recovery failure, no-auth routes, OAuth cancellation, and failed post-apply verification without mislabeling the saved state.

Do not print token fragments or secret-derived hashes. JavaScript cannot guarantee zeroization; drop references promptly and do not claim stronger guarantees. A compromised credential renderer can observe input while typed, and a compromised OS account is outside this isolation model. OS credential vault integration is not implied by `.env`/`auth.json` storage.

PR6 provides latest-Apply inspection after a full application restart. Only the selected profile operation ID/state is returned; journal contents remain private. See [current operating behavior](models-and-providers.md) and [implementation evidence](../../planning/desktop-pr6.md).

## Agent-requested browser input

Desktop-hosted Session turns supply the runtime's existing secure-input coordinator
with a native collector. A pending request exposes only its opaque ID, verified
origin, input kind, group position, and expiry. The conversation offers **Enter
securely**; Main claims the request and opens the protected credential window.
Ordinary renderer IPC accepts only Work/request IDs, never values or destinations.

Values use the inherited credential descriptor and the authenticated profile-scoped
private owner socket (`secure.input`). These commands bypass control receipts and
Session input persistence. Profile, Session, target generation, current workspace
trust, expiry, and exclusive window claims are checked. The existing coordinator
re-verifies browser destinations before delivery; grouped inputs are collected
before any field is delivered. Its existing broker clears byte buffers after use
or cancellation. JavaScript strings cannot promise deterministic memory erasure.

Closing a claimed input or its credential channel cancels it. Profile changes fence
late callbacks. Unanswered requests expire within two minutes (or the coordinator's
earlier expiry); the native window closes at expiry. Requests are ephemeral and
are never replayed after a restart. These controls currently serve shared-host
Session turns, not durable Task-worker secure-input continuation. A stopped turn
remains stopped; the UI does not relabel it as a resumable input request.

After updating this code, restart both the desktop bridge and its shared local
runtime once active work has settled. An already-running supervisor retains its
old code. Existing browser URL, approval, takeover, and cloud-spend policies apply.
