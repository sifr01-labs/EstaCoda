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

## Commit 4 — File execution evidence and final review

File output requires a successful workspace write/patch and subsequent complete,
materialized readback of the same target with matching SHA-256 content digests.
The reconciliation uses current-turn executor call IDs and successful receipts;
provider prose, unrelated files/tools, old-turn records, partial reads, unsaved
editor content and unowned artifacts cannot satisfy it. An unchanged matching
write qualifies. Later writes, deletes or contradictory reads invalidate earlier
readback. Digests are workspace-tool result metadata, not authority or persistent
request state.

An unmet file requirement keeps the final outcome blocked/partial and replaces
unsupported provider completion text with a deterministic explanation. Missing
file tools are identified explicitly. Information-only responses keep their
existing behavior. A recognized durable Task handoff can complete foreground
dispatch while its objective remains pending; Task-owned output reconciliation
and cross-turn/restart continuity remain PR 4.

Final review also preserved existing negative/defer diagnostic evidence for
educational API requests and completed discovery routing for explicit research
reports and delegated research in English/Arabic/mixed language. General reports
use topic-appropriate web sources; academic APIs are used only when relevant.
Paper writing remains the separate researcher workflow.

Measured development results are recorded in
[research-reliability-pr1.json](../../evals/baselines/research-reliability-pr1.json):
8/8 intended skill selections, 8/8 selection precision, 22/22 requested capabilities
exposed, and zero unwanted exposures in negative controls. The same scripted
three-turn no-action scenario now blocks the unsaved-file turn. Four research
method/evidence probes still falsely complete without execution; these remain
explicit PR 4 characterizations, not release acceptance. The PR 0 historical
artifact was not overwritten.

Security review: this changes routing and completion, not execution authority.
Session catalogs, child tool restrictions, file containment, approvals, cloud and
network policy remain authoritative. File verification records observed bytes;
it does not establish scientific correctness or guarantee a file cannot later
change. No dependencies, lockfiles or unrelated user work were changed.

## Validation

- Node 24.14.1; pnpm 10.33.0; frozen-lockfile installation passed unchanged.
- Full source suite passed 11,827 tests in 738 files; final report-routing changes
  also passed their focused router, eval and real-runtime acceptance tests. The
  final quoted-filename safety review passed 217 focused tests after the full run.
- Tracked-source typecheck and build passed with temporary external configs that
  exclude unrelated untracked duplicate files. Repository configs are unchanged.
- Runtime import and compiled ESM audits passed.
- Ordinary typecheck/build remain blocked by the three pre-existing duplicate
  declarations in untracked `src/types/bidi-js.d 2.ts`.
- Source and compiled smoke each passed 12/13 cases. Their Evolution lifecycle
  case invokes ordinary typecheck and hits that same unrelated duplicate file.
- Diff whitespace checks passed.

This implements PR 1 in the shared runtime, not a packaged release. Catalog
budgeting/native exposure enforcement, recovery, Task/restart reconciliation,
capability-memory grounding and packaged Desktop/CLI/Telegram release validation
remain in PR 2–6. No Jev integration was introduced.
