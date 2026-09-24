# Capability reliability — PR 6 implementation record

Status: deterministic routing/workflow gates implemented; packaged and live-provider release acceptance are separate required gates. Work continues on `ame/reliability-baseline`.

## Frozen routing corpus and measured scope

`assets/evals/research-routing-v1.json` contains 180 labeled cases in 30 seed families: 120 development and 60 held-out, with 60 Arabic, 30 mixed-language, and 60 negative/informational/ambiguous cases. Translations and paraphrases of each seed share a split. The fixture pins the corpus SHA-256 and enforces seed isolation and exact prompt-plus-prior-context separation. A pre-release audit found one repeated save-only context across splits; the corpus records the original hash and correction to the held-out urban-heat context. Labels were unchanged, no miss was reclassified, and no runtime tuning followed held-out scoring.

The classifier uses all 22 real bundled skills, the real IntentRouter and narrowing code, and 109 real registered runtime definitions. Definitions are treated as available in this controlled classification probe. Actual availability, execution and approval are independently exercised by the workflow/security suites. This distinction prevents classification metrics from being presented as live readiness or completion guarantees. Semantic routing remains shadow-only.

Development cases exposed three narrow defects: combined research/file requests could lose web exposure; Arabic file verbs with object pronouns were missed; and mixed greetings exposed tools. Explicit “using the … skill” references also needed preservation on rerun. Fixes retain negation/quoted-text filtering and session-filtered catalog admission. Exposure does not grant approval or execution authority.

Held-out results (denominators retained):

| Language | Requested-tool recall | Primary-skill precision |
| --- | --- | --- |
| English | 45 / 45 | 6 / 6 |
| Arabic | 30 / 30 | 6 / 6 |
| Mixed | 15 / 15 | 3 / 3 |
| Total | 90 / 90 (100%) | 15 / 15 (100%) |

Primary-skill recall is **15 / 24 (62.5%)**, not 100%. All nine missed expected skills recover through one bounded expansion round and a real skill instruction read with an owned receipt. Recovery is measured separately and never added to first-pass numerators. The held-out schema estimate is median 7,828 / p95 15,429 tokens, below the unchanged 24,000-token and 100-schema ceilings. Greeting cases expose zero tools. These are rough schema estimates, not provider-billed tokens.

The paired PR 0 development probe retains the same 18 prompts and seven-tool catalog: requested-tool recall improves from 14/22 to 22/22; primary-skill recall from 3/8 to 8/8; schema median from 84 to 112 and p95 stays 196. The median increase includes corrected file-tool exposure. That catalog lacks the production recovery schemas and is not directly comparable to the release corpus. Its legacy no-execution completion-floor counterfactual remains 4/9; it does not invoke the runtime's request-evidence guards and is not a real false-completion rate.

## Executed workflow and safety gates

`pnpm run validate:research-reliability -- <report.json>` fails on routing thresholds, safety/requirement violations, failed recovery, or failed owning test suites. `research-routing-release` and `research-workflow-release` are also registered with the existing eval runner.

The reusable runtime fixture creates three durable worker Steps and their dependent synthesis, executes real child runtimes, reads all three accepted results, and keeps the Task partial while the requested file is missing. After runtime/DB restart, a save-only follow-up reads the accepted synthesis, writes the report and verifies readback without creating another Task or repeating searches. Measured: 3 workers, 4 accepted results, 1 Task, 3 searches, 15 scripted provider calls, 10 actual tool calls, and a nonempty verified report. No live model calls occur in this fixture.

The release runner covers the A1–A16 execution matrix through the existing owning suites:

| Matrix | Executed owning coverage |
| --- | --- |
| A1–A4, A9–A10, A13 | Research request acceptance: three workers, skill rerun, missing capability, partial results, file denial/readback, save-only and restart |
| A5–A8, A13, A16 | Capability recovery, tool catalog/schema, narrowing, skill visibility and executor tests: bounds, excluded scope, spoofing, same-batch rejection, fallback and approval preservation |
| A11 | Capability-state and memory extraction/review/cleanup tests |
| A12 | Public web-read reuse and provenance tests |
| A14–A15 | Frozen multilingual corpus plus request-requirement negatives |
| A17 | CLI/gateway owning regression suites run here; equivalent real-runtime entry-point and rebuilt Desktop scenarios are recorded separately below |

The first commit's release runner passed 834 tests, with zero failures. Tracked-source typechecking and diff checks passed. Full standard and rebuilt-package checks are recorded with the second commit. Detailed measurements are in `evals/results/research-reliability-source-v1.json`.

## Outstanding release assessments

The live assessment requires five approved scenarios with three repetitions each, a selected provider/model, approved research sources, and a predeclared spend ceiling enforced by existing policy. Those parameters have been requested. Scripted provider responses do not establish citation quality or live completion rates, and no real Telegram chat is used without separate authorization.
