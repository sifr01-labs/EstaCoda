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
