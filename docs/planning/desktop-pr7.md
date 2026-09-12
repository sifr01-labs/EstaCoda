# Desktop PR7 implementation record

Branch: `ame/desktop-foundation`; base: `4a7efb7e`.

## 1. Work list and detail routing

The live Work navigation opens a canonical list with conversation, Task, and active-state filters. Filters apply to the explicitly loaded extent; pagination remains bounded to 2,000 items. Detail selection continues to resolve off-page Work through `work.get`. Local draft and list routes never masquerade as canonical identifiers. Existing per-Work tabs and inspector state remain intact.

Validation: desktop foundation/type boundary checks and desktop unit tests; live list navigation covered by the Work continuity browser suite.

## 2. Bounded search and profile-scoped pins

`work.list` accepts a bounded title/workspace/ID query. Search cursors bind to the normalized query, page size, and capture epoch; the renderer debounces queries and rejects late results. Search is metadata-only and does not scan transcripts. Main persists at most 100 canonical references per profile in presentation storage; titles and execution state remain canonical reads. Off-page pins resolve through `work.get`; profile changes fence pending reads and writes.

Validation: 68 focused core/protocol tests, 35 desktop unit tests, desktop foundation checks, and eight Work continuity browser journeys. Security review: no caller-supplied profile or filesystem path enters pin storage; references cannot authorize execution.

## 3. Target-scoped prompts and validated attachments

New Work selects an existing trusted core target and optional per-Work model. Main starts a canonical Session through the bridge, waits for preparation to settle, and submits the immutable prompt to the supervisor. Local drafts retain text, target, model and attachments across navigation. Native file selection stages actual UTF-8 contents in Main, with four files per prompt, 8 KB per file, a combined input bound, 15-minute expiry and profile/connection/target/draft fencing. Binary formats are explicitly unsupported. Selecting a file grants no tool execution authority. Reference-only operation records permit inspection after restart and prevent automatic resend of an accepted draft.

Validation: 70 core/protocol tests, 37 desktop unit tests, nine browser continuity/composer journeys, desktop foundation and root typecheck in the tracked-source validation checkout. Review covered stale selectors, file replacement, payload size, profile changes and uncertain dispatch. Target creation and managed worktree lifecycle remain PR9; this slice discovers existing trusted targets without creating or trusting directories.

## 4. Assistant and tool activity

The shared owner keeps a 16 KB ephemeral assistant preview, reset at tool boundaries and discarded when the turn settles. A selected Work view reads it through authenticated, target-fenced private inspection at most once per second, with one request outstanding. This read does not start a host or persist a second transcript. Canonical tool/message history continues through the bounded snapshot subscription path; history now refreshes even when a new event leaves the Work timestamp unchanged. Disconnects discard previews, and canonical outcomes remain the source of completion truth.

Validation: shared-host preview/cancellation tests, protocol conformance, root and desktop typechecks, and eleven Work continuity browser journeys. Review: preview memory and response sizes are bounded; profile and target generation are checked; no raw tool input or result enters the preview.

## 5. Plans, Tasks and child agents

Work has bounded, canonical parent/child navigation and the inspector renders the latest plan. Child queries are cursor-bound to the parent and preserve their loaded extent across refreshes. Delegated agent Sessions expose their canonical history under the parent, while Task worker Sessions link under their actual attempt. These child views expose inspection only; they do not acquire independent send/model authority. Operator-only host Sessions remain outside navigation.

Validation: 71 core/protocol tests, desktop unit and foundation checks, root typecheck, and twelve browser Work journeys. Review covered off-page descendants, same-profile parents and child execution controls.

## 6. Lifecycle, guidance, model controls and durable creation

Main re-resolves capability hints and immutable Work bindings before lifecycle controls. Session Stop reports requested cancellation separately from Work outcome; Task pause/resume/cancel/retry and bounded guidance use existing supervisor operator services. Existing per-Work model controls remain available at supported boundaries. New Work can explicitly create a durable background Task after reviewing limits and authority. Creation uses a Main-owned ID and core idempotency key, inherits the target and profile spending cap, and can only narrow the existing operator limits and authority. Model selection and Task creation commit atomically before a worker can be scheduled. Settled inspection pointers may be evicted under the bounded presentation journal; unresolved pointers are retained.

Validation: 87 targeted lifecycle/protocol/Task tests, 38 desktop unit tests, fourteen browser Work journeys, root/desktop typechecks, and a real bridge/private-owner creation, approval, reconnect and Task pause journey. Security review: the renderer never supplies Task IDs, operation IDs, profile identity, grants or authority policies. Child workers remain inspection-only; ambiguous dispatch is inspected rather than automatically replayed.

## 7. Approve-once and reject cards

Live cards show the pending action, profile, target and isolation, with approve-once/reject choices from the canonical projection. Main looks up the Inbox item independently of pagination, validates its Work target and records a decision reference before routing to the supervisor. Repeated clicks inspect the original operation. Cards never label a decision as Task completion, and lost replies expose receipt inspection. No persistent grants or queue writes originate in Electron.

Validation: 71 approval/protocol tests including hardline, expiry and stale-generation rejection; 39 desktop unit tests; sixteen Work browser journeys; root and desktop typechecks. Boundary review also rejected extra private Task-limit fields that could override concurrency and preserved safe attachment-expiry/input-limit errors without exposing filesystem paths.

## 8. Needs-attention workflow

Inbox supports category filtering, off-page Work review, return/next-request navigation, and provider setup routing for unbound setup requests. Other repair and governance requests expose their canonical details and the currently available repair path; they do not invent desktop mutations for later milestones. Profile-only attention carries canonical action hints even before a Session database exists. Decisions remain visible until canonical state removes them.

Validation: five focused bootstrap/Inbox tests, eighteen browser Work/Inbox journeys, root and desktop typechecks. Review covered unbound setup entries, resolved-item focus, filtering and navigation continuity.

## 9. Canonical usage and runtime counts

The inspector reads the canonical provider ledger, including Session compression lineage and originating Task spend, within a 4,096-entry/128-root-Task inspection bound. Missing usage, missing prices, provisional totals, truncation and unavailable context are explicit. Runtime counts distinguish root Sessions, Tasks, approvals and schedules without double-counting attempts or child workers. Completed turn outcomes take precedence over cached ownership leases. Target groups use identity rather than display labels, and requested Docker policy is never presented as verified isolation.

Validation: 87 focused core/protocol tests, an additional real-ledger truncation check, 39 desktop unit tests, nineteen browser Work journeys, root and desktop typechecks. Review covered profile isolation, context invalidation, stale Work selection and bounded lower-bound accounting.

## 10. Integration, restart, visual and release validation

Native acceptance now exercises production Main/preload, the standalone bridge, the private socket, real supervisor ownership locks, durable receipts and core Task/model/approval services. A deterministic runtime receives actual native-picker attachment contents once, waits for approval through application restart, and continues after approve-once. Search, pins, model overrides, bounded Task creation/pause, bridge termination, profile switching, application restart and supervisor restart are checked without automatic replay. The unchanged hardened macOS package is also launched from a path containing spaces and Arabic.

Final review corrected concurrent attachment staging so simultaneous requests cannot exceed the 64-handle limit, counted running compression-successor Sessions without counting child workers, and replaced the stale pre-PR6 setup banner with a direct Models & providers action. The native welcome area retains its content height so new workspace/Task controls cannot overlap its text in short windows. The older lifecycle fixture now supplies the complete target workspace identity required by its type. No safety check or visual golden was relaxed.

Validation:

- `validate:execution-release`: frozen install, conformance, root typecheck, **666 core test files / 10,866 tests**, smoke, build, runtime-import/ESM audits, distribution smoke, call/token budgets, source and built Docker execution, and Docker image validation.
- `desktop:foundation:check`: pure protocol, desktop typecheck and Node/Electron import boundary.
- `desktop:test`: **12 files / 41 tests**, including concurrent attachment staging, expiration and disconnected/profile-scoped counts.
- `desktop:e2e`: **131 visual/interaction checks**, including twenty live Work continuity journeys; frozen prototype and golden images unchanged.
- `desktop:package` and `desktop:native`: macOS arm64 package/signature, CSP, fuses, supplied icon, native resize/200% zoom, credential isolation, Work controls and restart journeys. Native evidence was regenerated intentionally and visually inspected.
- `git diff --check`.

Root validation and packaging use a tracked-source checkout on this machine so pre-existing untracked duplicate source files do not contaminate TypeScript discovery; those user files remain untouched. The tested desktop bundles are copied back after packaging/signing completes. Desktop unit and browser checks run from the working repository.

Risk/limits: PR7 crosses execution, approval, attachment and profile boundaries; Main owns presentation references, while core retains all execution and grant authority. The native Work runtime is deterministic, not a paid-model production soak. Windows/Linux native releases, real-account OAuth, large-profile load testing, binary attachment extraction and later target/file/artifact/integration milestones remain outside this PR. Existing trusted targets and the documented payload/inspection bounds are required.

## PR6/PR7 review follow-up

The focused follow-up fixes delayed Task preparation recovery, persists pending
Work model-control references across Main restarts, connects draft inspection to
the selected target and canonical next-turn route, and reconciles cancellation
notices with terminal Work outcomes. Profile approval mode is explicitly labelled
as profile policy; the next-turn/next-attempt model is not claimed to be the model
of an already-running turn. Missing reads remain unavailable.

Recovery reuses the bounded, profile-scoped, reference-only operation journal.
Preparation receipts cannot be evicted as if they were completed submissions.
Targets are revalidated before continuing; uncertain operations are inspected,
not replayed. No prompt, attachment contents, credentials, or model selection is
written into the journal, and execution ownership remains with the supervisor.

`pnpm run desktop:native:execution` adds a macOS native acceptance journey after
`pnpm run desktop:package`. It starts the real supervisor, uses the production
Desktop/Main/preload/bridge and runtime/Task scheduler/worker, and scripts only a
no-auth loopback provider. It proves canonical Session completion, keeps a Task's
provider request in flight across full app restart, verifies no request replay,
and checks its completed result persists through another app restart. This tests
app restart, not an executing owner's crash or real-provider availability.

Validation for this follow-up: 44 desktop unit tests, 132 browser/visual tests,
69 focused protocol/target tests, and 10,866 core tests passed. Frozen dependency
installation, typechecks, smoke, build, runtime-import/ESM audits, distribution
smoke and execution budgets passed. The isolated source copy excludes unrelated
untracked duplicate files in the working checkout; Docker checks use a workspace
under the engine-shared repository path. Source/dist Docker conformance and image
validation passed there. The native execution journey and existing macOS native
integration, recovery and package checks passed.

Risk review: changes touch recovery references and display-only policy metadata.
They preserve profile/target fences, canonical receipts, trust and approval gates,
and introduce no new execution authority or credential transport.
