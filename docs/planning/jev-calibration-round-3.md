# Jev calibration, round three — 14 October 2026

**The frozen candidate passed the fresh routing gates.** The shared runtime now uses the measured work-specific questions with one shared threshold pair: accept at or above **0.75**, reject at or below **0.4**. Intermediate answers still use candidate-level Standard fallback. This is a measured improvement for pinned `jev-1.13.0`, not a claim of perfect calibration or completed packaged release validation.

## Method and candidate selection

Baseline: `09c333e1`, including the preceding request-parsing and tool-exposure repairs. All 80 previously observed v1/v2 cases became development cases. Twenty-four new acceptance requests were frozen before running development and evaluated three times after choosing the candidate. They cover conversation, capability questions, quoted instructions, local inspection, code changes/tests, explicit complementary skills, save-only continuity, research, browser navigation, status inspection, Arabic and mixed language. They share semantic families with development; they are not 72 independent real-world tasks.

Expected labels never enter provider requests. The fixture uses production routing functions, bundled skills and 109 registered tool definitions. No selected benchmark tool is executed. The corrected git-diff rubric allows `terminal.inspect` or `terminal.run` and makes a separate file read optional.

Three live development runs compared current questions, the existing `scoped-work` experiment, and a stricter `workflow-fit` skill question. Eleven threshold configurations were replayed without additional provider calls. The stricter skill question removed incidental skill selections but missed part of an explicit two-skill request; it was rejected. A single shared 0.75/0.4 pair with `scoped-work` retained all required tools and skill loads while reducing excess selections. The candidate was frozen before inspecting acceptance results and was not retuned afterward.

| Development, 80 cases | Current policy | Selected candidate |
| --- | ---: | ---: |
| Required intent choices retained | 58/79 | 75/79 |
| Required tool choices exposed | 83/89 | 89/89 |
| Explicit required skills loaded | 9/9 | 9/9 |
| Rubric-excess tools | 1,475 | 946 |
| Rubric-excess skills | 6 | 5 |

The predeclared gates required ≥95% required-tool recall in every acceptance trial, no regression against baseline, ≥85% aggregate required-intent recall, all explicit skill instructions loaded, no increase in excess tools/skills, no regression in raw required intent/tool recall, and passing governance regression tests. All passed. These are selection gates, not authorization or task-completion guarantees.

## Fresh acceptance results

| Metric, 24 requests × 3 trials | Current policy | Frozen candidate |
| --- | ---: | ---: |
| Raw Jev required intent choices | 44/69 | 66/69 |
| Final required intent choices | 47/69 | **69/69** |
| Raw Jev required tool choices | 29/84 | 72/84 |
| Final required tool choices | 83/84 | **84/84** |
| Explicit required skills selected and instructions loaded | 12/12 | **12/12** |
| Rubric-excess tool selections | 1,172 | **730** |
| Rubric-excess skill selections | 0 | 0 |
| Rubric-excess intent selections | 16 | 6 |
| Routing latency, median / p95 | 1,109 / 1,205 ms | 1,141 / 1,322 ms |

Candidate required intents were **23/23 in each trial**; required tools were **28/28 in each trial**. Excess tool selections fell **37.7%**. Raw and final choices are deliberately separate: the runtime still relies on explicit prerequisites, skill dependencies and Standard fallback. Tool precision is not perfect even when required recall is perfect.

One candidate intent request (`r3-social`, trial 0) returned **HTTP 499**, recorded as `service-error`. Its fallback outcome is included; the request was not rerun or excluded. Baseline recorded no provider failure. These observations do not establish a provider failure rate. There was no recorded authentication or credit failure.

Across all live development and acceptance runs: **384 case-trials, 1,178 recorded provider requests, 10,894,587 reported tokens, estimated US$0.408480**. Failed requests can have incomplete usage; the estimate is not an invoice. Replays made no provider calls.

## Runtime change and review

The production intent descriptions now distinguish actually doing work from discussing an ability, supplied code from repository inspection, and browsing from source extraction. Each intent/capability question names its subject directly. Skill questions ask whether the user requests the taught work now or explicitly invokes the skill; complementary skills remain independent. The generic true/false criteria were removed in the tested candidate. Discovery retains its original user-objective and no-new-authority boundary.

The threshold pair is shared across intents, skills and capabilities; there are no per-label overrides or special-case score patches. Choice/Score minimum confidence remains unchanged. The evaluation runner defaults to the production threshold constant, so a future `--variant baseline` measures the actual current policy.

After integration, the production `baseline` path replayed all **72** frozen candidate case-trials with exact question/context hashes, identical raw/final selections, identical scores and identical loaded-skill lists. This verifies the implementation matches the evaluated candidate. The stricter rejected question remains evaluation-only.

Security review: this changes relevance decisions, including the probability range that is accepted or delegated to Standard. It does not grant execution authority or change workspace trust, catalog visibility, stale-response checks, explicit prohibitions, approvals, task-session authorization, schema budgets, profile credentials or configuration. No new dependency or model-visible tool was added. Standard mode is unchanged.

## Limits and validation

Four required-intent misses remain in the selected development replay: a thanks message, a request to discover file-writing capability, a supplied-data summary, and an abstract capability question. Five unrelated skills remain: dogfooding on four browser requests and wiki-builder on one research request. Those are retained as failures, not relabeled as acceptable. Coordinated explicit skill phrases can still depend partly on semantic selection; this experiment does not prove unconditional deterministic extraction of every skill name.

The corpus is synthetic and agent-labeled. The tool fixture does not test live availability, external MCP catalogs, private user catalogs, attachment processing, or other Jev versions. This calibration does not prove deep research quality, report correctness or end-to-end task completion. Actual app/gateway build identities and packaged workflow acceptance still need a separate run.

Validation used isolated tracked source plus this patch, preserving unrelated checkout changes:

- **270 focused tests** passed, including Jev transport, selection, request boundaries, evaluation scoring and exact threshold/fallback boundaries.
- **12,401 core tests across 763 files** passed.
- Frozen dependency installation, core typecheck and separate evaluation-runner typecheck passed. A type-only assertion in the new experiment test was corrected before the passing run.
- Production replay reproduced all 72 acceptance case-trials without a provider call.
- Source smoke, build, runtime-import audit, ESM audit, compiled smoke and diff/whitespace checks passed.

The installed Desktop app and gateway were not updated by this calibration.

## Evidence and reproduction

- [Corpus and frozen acceptance requests](../../assets/evals/jev-routing-v3.json)
- [Results, frozen gates, development comparisons and case-level evidence](../../evals/results/jev-calibration-round-3.json)
- Full local synthetic trace archive: `/tmp/estacoda-jev-calibration-round3-evidence-2026-10-14.tar.gz`; its hash is recorded in repository evidence. It excludes credentials and usage databases.

```sh
# Current production policy, billable synthetic routing requests; no tool actions.
pnpm run eval:jev --live --corpus assets/evals/jev-routing-v3.json --split acceptance --repeat 3 --variant baseline --output /tmp/jev-current-check
# Same source/catalog and recorded requests, no provider calls.
pnpm run eval:jev --replay /tmp/jev-current-check --corpus assets/evals/jev-routing-v3.json --split acceptance --repeat 3 --variant baseline --output /tmp/jev-current-replay
```

Historical variants are source-dependent transformations. Reproducing the original baseline/candidate comparison requires its recorded base source plus evaluation changes; the promoted production baseline reproduces the accepted candidate. Acceptance cases are now observed diagnostic material and must not be reused as an untouched gate for future tuning.

## Explicit multi-skill follow-through

Explicit English invocations now retain coordinated names (`use both the researcher skill and the system-diagram skill`, or `use the researcher and system-diagram skills`). This is a bounded request requirement, independent of Jev probabilities. The existing four-reference limit, deduplication, session-visible resolution, readiness and confirmation checks remain in force. Quoted instructions, hypotheticals, negation and unrelated mentions do not create requirements. Coordinated workers still inherit an explicit invocation. Regression tests reject every Jev candidate and verify that both requested instruction bodies load. Standard mode and full Jev service fallback also retain all resolved explicit skills and their bounded instruction bodies, with canonical-name deduplication and confirmation computed across the complete selection. An unavailable reference still prevents silently substituting a partial selection.

The packaged research acceptance harness checks fallback attribution through the response info popover before and after restart, matching the current Desktop UX. Routing selection does not establish research quality or successful delivery; those require the packaged and live workflow checks.
