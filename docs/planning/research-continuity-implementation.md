# Research evidence and continuity — PR 4

Implementation on the existing `ame/reliability-baseline` branch.

## Slice 1: bounded request continuity

`feat(runtime): persist bounded request requirements across follow-ups`

Foreground checkpoints optionally retain a strictly validated request-requirements field. Multi-part research qualifies for a checkpoint without requiring browser or connector work. Version-1 checkpoints without requirements remain valid. The field contains user intent only; it cannot contain satisfied flags, tool grants, raw model output, or absolute file targets. Replay requires immutable requirements in a coherent profile/session-owned checkpoint chain.

Reruns carry the original objective, freshness, and worker count into a new checkpoint with fresh turn attribution. Save-only follow-ups require the newly requested file output and instruct the provider to reuse the prior result. Cancellation and explicit new objectives supersede the old work. Requirements are re-resolved against the current runtime; prior tool exposure or approval does not carry forward.

Review focused on malformed/oversized state, cross-profile replay, quoted/negated follow-ups, fresh receipt attribution, and runtime restart using the same session database. Targeted checkpoint, routing, and research acceptance tests and an isolated tracked-source TypeScript check passed. The existing unrelated untracked duplicate declaration remains outside this change.

Task evidence reconciliation and verified research-result delivery are addressed in the following two commits; this first slice does not assert that worker or source requirements are already satisfied.
