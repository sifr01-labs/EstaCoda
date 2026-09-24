# Capability reliability — PR 6 implementation record

Status: deterministic, three-surface and rebuilt-package gates passed. Live-provider assessment remains pending approved model, sources and spend ceiling; overall release acceptance is not yet complete. Implemented on the existing `ame/reliability-baseline` branch.

The subsequent gap-review fixes and their new measurements are recorded in [reliability-review-fixes.md](reliability-review-fixes.md). The measurements below describe the original PR6 build.

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

## Three-surface and packaged acceptance

`src/runtime/research-surfaces.acceptance.test.ts` runs the production CLI session loop and authenticated Telegram gateway over the same real runtime, durable Task workers, result store and file tools. Its seven tests cover three-worker research, synthesis, restart/save-only continuation, skill recovery, unavailable search, false save claims and an unauthorized Telegram sender/chat. The fixture owns runtime disposal across turns; the real entry points still process each request. Model responses and Telegram transport are synthetic. The same `open` security mode is used for the successful workflows; existing strict/adaptive/open, hardline, approval/denial, stop-interruption, session ownership, Task delivery and media-adapter suites remain separate executable gates. No real bot or chat was contacted.

`pnpm run desktop:research-release -- <app-path> <report-path>` launches the actual ad-hoc signed macOS arm64 app with an isolated HOME/profile and a PATH without Node or EstaCoda. It verifies the complete packaged runtime inventory, compares compiled core files against the current distribution, and checks that the app launches its retained owned Node/core bridge. The supervisor and Task scheduler also run from that package. The only provider substitutions are a local scripted model HTTP server and a registered synthetic web provider in the packaged supervisor. No renderer, bridge, executor, approval decision, Task result or file receipt is mocked.

The five packaged scenarios passed: three-worker research, save-only after app restart, skill recovery with successful instruction-read evidence, unavailable-search admission rejection and a blocked false-save claim. Assertions wait for the exact submitted user message's persisted outcome, not an admission receipt or a cached UI status. The report retains base-commit and source-overlay hashes because this measurement precedes the second commit.

Measured package: Node `v24.14.1`, core `0.1.0`, runtime SHA-256 `4136f9f681aa539bebca880b0803c2d3d2fad2f77c116071c02938839e622177`. Research plus save used 13 scripted provider calls, 3 workers, 4 distinct child sessions including synthesis, 4 accepted results, 1 Task, 3 searches and a 655-byte report verified by readback. All five scenarios used 20 provider calls and produced 14 actual persisted tool results; the one failed tool result is the expected unavailable-search rejection. The source fixture uses 15 calls because it reads three synthesis dependencies separately; the packaged fixture reads them in one batch. This is a fixture sequencing difference, not a measured model-efficiency gain.

The Task's historical settlement remains `partial` because its original file was pending at settlement. The later foreground save has its own verified completed outcome, consistent with PR 4; it does not rewrite historical Task settlement. App restart creates no new workers or repeated searches. Detailed package evidence is in `evals/results/research-reliability-packaged-v1.json`.

## Validation and review

The original workspace contains unrelated duplicate source/dependency files, including a duplicate `bidi-js` declaration. They were preserved. Standard validation and packaging ran in a clean detached checkout of `12e60f3b` with the second commit's source changes copied explicitly. A fresh frozen install with an isolated pnpm store avoided a cloud-placeholder duplicate that stalled the first dependency-copy attempt. The pinned Electron install hook was run explicitly because its binary was absent after installation. No lockfile or packaging-policy change was needed.

| Check | Result |
| --- | --- |
| Node / pnpm | `v24.14.1` / `10.33.0` |
| `pnpm install --frozen-lockfile` (isolated store) | Passed |
| `pnpm run typecheck` | Passed |
| `pnpm run test` | 11,970 tests, 746 files passed |
| `pnpm run validate:research-reliability -- <report.json>` | 1,225 tests across 31 owning suites; deterministic gates passed |
| `pnpm run smoke` / `pnpm run smoke:dist` | All cases passed in each |
| `pnpm run build` (invoked by packaging) | Passed |
| `pnpm run audit:runtime-imports` / `pnpm run audit:esm` | Passed |
| `pnpm run desktop:package` | Passed; actual signed package launched |
| `pnpm run desktop:research-release` | Five packaged scenarios passed |
| `pnpm run desktop:typecheck` / packaged test typecheck | Passed |
| `pnpm run desktop:test` | 173 tests, 46 files passed |
| `git diff --check` | Passed |

Review covered session/profile isolation, deterministic corpus separation, successful instruction and file receipts, missing capability rejection, provider/schema bounds, narrower child envelopes, restart replay and package provenance. Public runtime and web-research docs now describe implemented behavior. Security risk remains concentrated in capability exposure, durable context and network/file execution; no approval, trust, profile, URL or hardline boundary is relaxed. These checks establish deterministic execution behavior, not live citation quality or universal task success.

## Outstanding release assessments

The live assessment requires five approved scenarios with three repetitions each, a selected provider/model, approved research sources, and a predeclared spend ceiling enforced by existing policy. Those parameters have been requested. Scripted provider responses do not establish citation quality or live completion rates, and no real Telegram chat is used without separate authorization.
