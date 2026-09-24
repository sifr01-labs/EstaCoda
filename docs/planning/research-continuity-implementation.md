# Research evidence and continuity — PR 4

Implementation on the existing `ame/reliability-baseline` branch.

## Slice 1: bounded request continuity

`feat(runtime): persist bounded request requirements across follow-ups`

Foreground checkpoints optionally retain a strictly validated request-requirements field. Multi-part research qualifies for a checkpoint without requiring browser or connector work. Version-1 checkpoints without requirements remain valid. The field contains user intent only; it cannot contain satisfied flags, tool grants, raw model output, or absolute file targets. Replay requires immutable requirements in a coherent profile/session-owned checkpoint chain.

Reruns carry the original objective, freshness, and worker count into a new checkpoint with fresh turn attribution. Save-only follow-ups require the newly requested file output and instruct the provider to reuse the prior result. Cancellation and explicit new objectives supersede the old work. Requirements are re-resolved against the current runtime; prior tool exposure or approval does not carry forward.

Review focused on malformed/oversized state, cross-profile replay, quoted/negated follow-ups, fresh receipt attribution, and runtime restart using the same session database. Targeted checkpoint, routing, and research acceptance tests and an isolated tracked-source TypeScript check passed. The existing unrelated untracked duplicate declaration remains outside this change.

Task evidence reconciliation and verified research-result delivery are addressed in the following two commits; this first slice does not assert that worker or source requirements are already satisfied.

## Slice 2: Task admission and settlement

`fix(tasks): reconcile research requirements through delegation and settlement`

The runtime supplies an immutable request contract through the executor context, never from model tool arguments. Admission checks the requested worker count, distinct research scopes, live-search requirements, delivered skill instructions, and terminal synthesis before creating the graph. Missing `web.search` directs the agent to the existing `config.web.setup` verification path. Extraction alone does not satisfy live search.

A successful foreground handoff retains a pending checkpoint linked to the Task. It is not objective completion. Task settlement checks accepted worker results in both settlement paths. A requested workspace file remains pending after read-only synthesis; a text result cannot prove a file save. Follow-ups carry the Task locator and expose authorized result/status tools instead of admitting duplicate research. Child steps receive the original objective and workflow as context, while deriving their own requirements from their assigned objective only.

Security review: the contract grants no authority. Existing workspace binding, session/profile checks, child tool narrowing, approval gates, and result acceptance remain active. Provider-supplied contract replacements are ignored. Both successful and failed worker coverage are exercised through the production scheduler and child runtime. Validation: 200 tests across seven targeted files and the isolated tracked-source TypeScript check passed.

## Slice 3: source grounding and verified report delivery

`feat(research): add source-grounded synthesis and verified report delivery`

Runtime-contracted live-source workers must return a bounded Markdown source/claim table (at most 24 rows and 16,000 table characters). The executor fills publication/revision dates only when explicitly observed in retrieved text, records the retrieval day, and labels snippets or extracted content conservatively. Extracted content does not prove full-text access. Supported claims and limitations remain model judgments; URL provenance does not establish scientific truth or verify numerical claims. Repository-only research retains its existing repository-evidence contract.

Synthesis must completely read every accepted dependency result through authorized Task tools. Page assembly checks Unicode offsets, full content hashes, accepted disposition and result identity, within a 256,000-character result budget. It must retain source/claim/limitation entries from the worker evidence and cover every accepted worker's sources. The executor adds the actual missing/failed scopes and the freshness limitation, independent of model prose. Failed or diagnostic worker output cannot satisfy the synthesis contract.

Save-only follow-ups reuse the authorized primary result. Successful workspace writes must match its content hash and receive a complete matching disk readback. Worker results, foreign results, incomplete pages, invented reports, unrelated writes and prior-turn receipts cannot satisfy delivery. A verified save names the actual relative file path. Partial research stays explicitly partial even when saving its report succeeds. Restart tests reopen the same session database, reject a replaced file, and verify a newly executed write/readback in the active workspace without creating more workers.

Cancellation or an explicit new objective can retire completed requirement continuity. Replay permits only these terminal-to-terminal retirement transitions; it does not reopen completed work or relax receipt-derived completion checks.

### Ownership and safety limits

The existing Task scheduler remains the research lifecycle owner, and existing delivery bindings remain the only answer-delivery owner. Synthesis stays read-only. After the PR0–PR6 gap review, a root request that includes a file adds a dependent report-delivery Step under the existing Task scheduler. It reads the accepted synthesis and verifies matching write/readback before settlement; missing capability, denial or invalid evidence keeps delivery incomplete. Only the exact requested file target (or report.md/report.txt when unspecified) is admitted for this Step. Its root-request authority does not broaden worker or synthesis authority. A later foreground save is a separate verified action; it does not rewrite historical Task settlement. Ordinary workspace saves do not require artifact registration. No new credentials, dependencies, global research store, authority grants or bypasses were added.

Source observations, synthesis, and file verification live in existing tool records, Task results and checkpoint events. Changes cover runtime/contracts/checkpoint continuity, durable admission and settlement, source-result validation, shared result reads, completion presentation, and deterministic acceptance fixtures. The public research skill catalog is unchanged.

### Validation

Environment: Node `v24.14.1`, pnpm `10.33.0`.

- Frozen dependency installation passed without a lockfile change.
- Slice 2: 200 targeted tests passed. Final focused review: 91 tests across six files passed, with additional checkpoint/controller replay tests passing separately.
- Final full suite: **11,918 tests passed across 742 files** (93.55 seconds). Local and remote completion presentation was also rechecked after the final wording review.
- Isolated TypeScript validation and build of all tracked source plus the new PR4 files passed. Temporary configs excluded unrelated untracked duplicate source files; no repository compiler configuration was changed.
- Runtime-import and ESM audits passed against that build.
- Standard `pnpm run typecheck` and `pnpm run build` remain blocked by the pre-existing untracked `src/types/bidi-js.d 2.ts` duplicate declarations (`BidiDirection`, `BidiEmbeddingLevels`, `BidiApi`).
- Source and distribution smoke each passed 12 of 13 cases. The Evolution lifecycle case invokes the same failing standard typecheck. These are not clean standard-gate passes.
- `git diff --check` passed.

The acceptance harness executes the production runtime, durable scheduler, child sessions, workspace file tools and persisted result service against deterministic in-memory provider/web fixtures. It covers three-worker accounting, unavailable search, partial workers, required skill delivery, save-only reuse, denial/missing readback and restart verification. This is PR4 core validation, not the PR6 held-out evaluation, live scientific-quality review, three-surface end-to-end matrix, or rebuilt Desktop package acceptance.
