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
