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

## Commit 3 — Exact tool exposure and delegation limits

Explicit delegation selects `delegate_task`, `task.status` and `task.result.read`;
file output selects `file.write`, `file.patch` and `file.read`. Selection only
intersects the existing session catalog. File-only output does not select shell
execution. Literature discovery uses required web tools without automatically
opening optional shell/research toolsets. Explicit skill requests expose the
existing skill inspection tools. Provider prompts carry the bounded requirements.

Requested worker counts outside the effective configured batch limit stop before
provider/worker execution and return an explicit blocker. Mixed Arabic/English
worker requests are covered. The durable three-worker acceptance control now uses
a natural-language skill/delegation request rather than slash-only routing.

Review and validation: 278 tests passed across analyzer, narrowing/policies,
runtime/builder, prompt, eval and real workflow acceptance suites. All 22 requested
capabilities in the development corpus are exposed; negative controls remain at
zero unwanted exposures. The catalog cap remains a separately characterized PR 2
gap. Admission/approval rules and child/session tool ceilings are unchanged.
