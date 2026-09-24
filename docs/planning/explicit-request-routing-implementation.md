# PR 1 implementation record

Work continues on `ame/reliability-baseline` at the user's request.

## Commit 1 — Bounded request analysis

The shared router carries turn-local request requirements derived from the original
user message, before context expansion and continuation text. The runtime attaches
the originating user-turn ID. The bounded record covers skill references,
delegation count, research scope/freshness, and Markdown/text output targets.
Negated, informational, hypothetical, fenced and quoted instructions are excluded;
quoted filenames remain usable operands. Unsafe or ambiguous targets are flagged.
These hints do not grant execution authority or persist requirements across turns.

Review and validation: 109 tests passed across request analysis, intent routing,
runtime routing and the PR 0 characterization suite. Ordinary typecheck still hits
the pre-existing duplicate declarations in untracked `src/types/bidi-js.d 2.ts`.
No unrelated duplicate files or worktree changes were modified.

Security note: requirements come from current user input, not provider/tool output
or expanded documents. Tool admission and authorization remain separate gates.
