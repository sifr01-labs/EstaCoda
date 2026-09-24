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

## Commit 2 — Skill references and literature workflows

Exact natural-language names and validated, bounded aliases resolve only from the
session skill registry. Negative/defer rules and confirmation still apply. Alias
collisions produce candidate names in the provider prompt; affirmative literature
or paper-writing context can disambiguate the shared `research` alias. New
literature patterns include noncontiguous English and Arabic requests. Discovery
now includes cited synthesis and an inspectable report template. Generic commercial
research does not select the academic paper-writing workflow.

The PR 0 corpus remains unchanged, including its desired labels; two additional
skill cases now pass (5/8 recall, 5/5 precision). General research requests without
academic context still have no selected skill. The historical v1 measurement is
preserved. Catalog outputs were regenerated intentionally.

Review: alias collisions, exact-name precedence, unavailable session skills,
negative/defer/confirmation behavior and source template delivery were checked.
147 focused tests passed before the final prompt/deferral checks. Tracked-source
typecheck passed. No execution authority or policy gates changed.
