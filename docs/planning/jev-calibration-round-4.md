# Jev selection calibration, round four — 15 October 2026

The frozen candidate passed the new acceptance gates. Required-tool exposure improved from **69/72 to 72/72**, while rubric-excess tool selections fell from **664 to 167 (74.8%)**. All **12 explicit skill obligations** were selected and their instructions loaded. This improves how the runtime applies Jev decisions; the pinned model (`jev-1.13.0`), questions and shared 0.75/0.4 thresholds are unchanged.

## What changed

Selecting a skill previously forced every member of its required toolsets into initial provider exposure, including tools Jev confidently rejected. Required toolsets now prioritize relevant dependencies without overriding individual decisions. Explicit request prerequisites and runtime-status/recovery tools remain protected. Unselected tools remain in the session catalog and can be requested later; selected dependencies that exceed the schema budget remain staged for recovery. Skill readiness and confirmation still apply.

The fresh development cases also exposed scope defects:

- A prohibition on searching removed `web.extract` even when the user explicitly requested reading a supplied page. Search and research restrictions are now separate: a search prohibition removes `web.search`, while a broader research prohibition still removes network research tools. Exact tool-name prohibitions remain binding.
- Negative phrases such as “No additional research” and “No web research is needed and do not save…” could create affirmative research requirements. Requirement derivation and Jev restrictions now share the negative-clause boundary.
- Replacing a URL with an inert operand swallowed adjacent sentence punctuation, joining a later prohibition to the earlier affirmative request. Sentence punctuation is preserved.

These are bounded selection and request-scoping corrections, not new execution authority or a general natural-language policy engine. No new subsystem, dependency, model call or threshold tuning was added. Standard selection retains its existing behavior; the shared request-scoping corrections also apply there.

## Method

Baseline: `9a901411`. Validation uses an isolated copy of tracked source plus this patch, excluding unrelated working-tree changes.

The 36-request synthetic corpus was frozen before live evaluation: 18 development requests and 18 acceptance requests. Acceptance ran three times after freezing the candidate. Scenarios include supplied-code review, local reads/searches, code fixes and checks, primary-source reads, delegated research, browser screenshots, saved results, save-only continuity, complementary explicit skills, runtime diagnostics, Arabic/mixed language and inert retrieved/quoted instructions. The semantic families overlap; 54 case-trials are not 54 independent user tasks. The corpus is agent-labeled, not independently adjudicated.

Production routing functions, bundled skills and 109 registered tool definitions were used. Expected labels do not enter provider requests. No selected benchmark tool is executed. The existing fixture does not exercise external MCP/private catalogs or attachment processing.

Because no model question or threshold changed, the controlled comparison replays identical recorded Jev responses through both code versions. The runner verifies question/context and catalog hashes. Raw selections were asserted identical in every paired case. Acceptance used fresh live candidate responses and baseline replay; development also includes a separate live candidate run, retained as additional evidence rather than mixed into the paired scores. The candidate was not changed after acceptance results were inspected.

Predeclared acceptance gates: at least 95% required-tool recall in every trial, at least 85% aggregate required-intent recall, all explicit skill instructions loaded, no required recall or excess tool/skill regression, and no raw-selection regression. All passed. The 85% intent gate is an acceptance gate, not a claim that every observed development scenario meets it.

## Results

| Fresh acceptance: 18 requests × 3 trials | Baseline replay | Frozen candidate |
| --- | ---: | ---: |
| Required intents selected | 51/57 | **54/57** |
| Required tools exposed | 69/72 | **72/72** |
| Explicit skills selected and loaded | 12/12 | **12/12** |
| Rubric-excess tools | 664 | **167** |
| Rubric-excess skills | 0 | **0** |
| Rubric-excess intents | 6 | **6** |

Required tools were **24/24 in each trial**. Raw Jev choices remain **54/57 intents, 63/72 tools and 6/12 explicitly required skills**. Deterministic explicit invocations, request prerequisites and candidate-level Standard fallback remain essential. The skill misses occur on the two-skill explanation request: asking for guidance from named skills does not require performing their usual external workflow, but still requires their instructions.

Live candidate routing latency: median **1,091 ms**, p95 **1,383 ms**. Baseline replay reuses recorded timings and is not an independent latency measurement. All 162 fresh acceptance provider requests returned without recorded provider failures.

| Observed regression material, paired replay | Required tools: before → after | Excess tools: before → after |
| --- | ---: | ---: |
| 18 fresh development requests | 22/23 → **23/23** | 243 → **58** |
| 80 prior development requests | 88/89 → **89/89** | 940 → **255** |
| 72 prior acceptance trials | 81/84 → **84/84** | 724 → **179** |

The prior corpus is compared against the current baseline, not the older round-three source revision. Its original historical totals therefore differ. Required-intent recall and explicit skill loading did not regress in any paired set. Fresh development intent recall remained only 16/19; the old development set retained four intent misses and five unrelated skill selections. These failures remain in the evidence.

Across this round's live runs: **90 case-trials, 270 provider requests, 2,461,185 reported tokens, estimated US$0.092045**. This is a usage estimate, not an invoice. An initial sandbox-blocked attempt is retained separately: 18 cases, 36 failed stage requests, zero reported tokens. It is excluded from quality comparisons because the provider was unreachable from that environment, not silently counted as successful Jev routing. Offline replays incur no new provider calls.

## Review, validation and limitations

Risk review: this narrows initial exposure while preserving session visibility, availability rechecks, stale-result rejection, stable aliases, schema limits, skill confirmation, workspace trust, approvals and executor authorization. Explicit requirements remain independent of Jev probabilities. Recovery controls remain reachable. A narrower initial selection can require later recovery; it does not remove the capability from the catalog.

Regression tests cover relevant complementary dependencies, recovery of rejected dependencies, budget staging, oversized explicit requirements, search-versus-read scope, negative fragments, URL sentence boundaries and broad research bans. The real runtime recovery tests explicitly invoke the researcher skill while Jev rejects its file-writing dependency; discovery and next-iteration recovery work, same-batch use is rejected, and write denial remains enforced, including after conversation-provider fallback.

Validation: frozen-lockfile installation, core typecheck and **12,462 tests across 763 files** passed. The initial isolated run lacked a workspace package link and sandbox permission for local test sockets; dependencies were installed correctly and the complete suite reran with socket access. Source smoke, compiled build, runtime-import and ESM audits, compiled smoke and the final diff review passed.

Remaining limitations:

- A simple rewriting request missed the `conversation` intent in all three fresh acceptance trials; it was not retuned away.
- Extra exposure remains: 167 rubric-excess tools across 54 trials, about 3.1 per trial. Some comes from unresolved candidates using Standard, rather than confident Jev acceptance.
- The synthetic selection benchmark does not establish task completion, scientific research quality, general model calibration, or reliability for unseen private/MCP catalogs.
- The installed app and gateway were not changed by this round. Earlier packaged/live workflow results belong to their documented builds and are not claimed for this patch.
- The acceptance set is now observed material and must not be reused as an untouched tuning gate.

## Evidence and reproduction

- [Frozen corpus](../../assets/evals/jev-routing-v4.json)
- [Paired summaries, gates, case-level scores and provenance](../../evals/results/jev-calibration-round-4.json)
- Full synthetic trace archive: `/tmp/estacoda-jev-calibration-round4-evidence-2026-10-15.tar.gz`; SHA-256 recorded in the structured evidence. Credentials, usage databases and user transcripts are excluded.

```sh
# Billable selection-only requests; no benchmark tools execute.
pnpm run eval:jev --live --corpus assets/evals/jev-routing-v4.json --split acceptance --repeat 3 --output /tmp/jev-r4-new-observed-check
# Replay identical provider decisions against another source revision with the same catalog/questions.
pnpm run eval:jev --replay /tmp/jev-r4-new-observed-check --corpus assets/evals/jev-routing-v4.json --split acceptance --repeat 3 --output /tmp/jev-r4-paired-check
```

A future tuning round needs a new untouched acceptance set; the command above is now a regression check only.
