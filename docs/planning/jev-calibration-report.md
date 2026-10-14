# Jev calibration experiment — 14 October 2026

**Correction following source review, 14 October:** Two original expectations were wrong. The read-only search-settings request should expect `config.provider.status`, not the settings-mutating `config.web.setup`. Git-diff inspection can use existing `terminal.inspect`; `terminal.run` is not required. Rescoring the original acceptance selections with the corrected search-settings label gives baseline **61/69**, candidate **59/69**. The original tables below retain the historical rubric and must not be used to claim a candidate recall improvement. The candidate still fails its release gate. See the [runtime repair and fresh evaluation](jev-routing-reliability-fix.md) for implemented changes and current results.

**Decision: do not promote the candidate.** Clearer questions substantially improved Jev's raw decisions and reduced excess tool exposure, but final capability recall failed the predeclared acceptance gate. Production questions, thresholds, user settings, app and gateway remain unchanged.

## What was measured

Runtime source: `ec423b65` on `ame/jev-assisted-routing`. Model: pinned `jev-1.13.0`, using the selected profile's existing credential resolver. The new evaluation runner calls the production intent/skill router, capability selector, Standard fallback and provider-tool narrowing functions. It loads 22 bundled skills and 109 registered tool definitions from the research workflow fixture. It records original probabilities separately from final exposure; fallback and mandatory dependencies cannot hide model misses in the raw score.

There are 60 synthetic, agent-labeled requests: 20 development, 20 calibration and 20 held-out acceptance cases. They cover English, Arabic, mixed language, informational/action distinctions, multiple skills, delegation, saving, discovery, prohibited actions and quoted material. Expected labels and acceptable-answer lists never enter provider requests. The candidate questions and synthetic request do.

Nine exploratory runs and two acceptance runs produced **300 case-trials**. Each acceptance configuration ran the same 20 requests three times. Including the connectivity canary, **988 real provider requests** reported **9,096,032 tokens**, with an estimated ledger cost of **US$0.342827**. All recorded live batches returned; none recorded timeout, authentication, billing, missing-answer or invalid-answer failure. An initial sandbox connectivity attempt could not access the network and was rerun with network access. The cost is an estimate, not a reconciled invoice.

These are routing tests, not execution tests. No benchmark request executed tools in the user's workspace, sent messages, or changed profile settings. Actual setup readiness, external MCP catalogs, attachment processing, Desktop/Telegram interactions, and end-to-end research quality are outside this experiment.

## Candidate and selection procedure

The production baseline uses acceptance ≥0.8 and rejection ≤0.2. Independent candidates between these cutoffs fall back to Standard.

Exploration compared the original questions, explicitly named subjects, direct questions, scoped intent definitions, and work-specific skill questions. Threshold sweeps replayed recorded answers without additional provider calls. The frozen candidate uses:

- Direct questions naming the candidate; explicit distinctions between doing work and discussing the ability to do it.
- Intent and skill acceptance ≥0.8, rejection ≤0.3.
- Capability acceptance ≥0.8, rejection ≤0.4.
- Existing independent multi-label selection, fallback, dependencies and authorization boundaries.

Lower acceptance cutoffs added unrelated selections without repairing the remaining calibration-set git-diff tool miss. Increasing rejection cutoffs reduced unnecessary Standard fallback on the development/calibration sets. The candidate was frozen before acceptance. It was **not retuned after examining acceptance failures**.

Before acceptance, the label rubric was corrected to allow the existing `simplify` skill as complementary to code review, and to make listing tools optional when an unknown explicit skill is already resolved deterministically. Original exploratory records retain their original corpus hashes. The first development baseline also predates a scoring correction that includes Standard's `taskClass`, rather than only `labels`. The acceptance comparison uses matching final corpus and scoring; do not compare old exploratory Standard intent totals as if they used that correction.

## Held-out results

Counts aggregate three repetitions; they are **not independent samples of 60 different tasks**. A required tool choice can allow alternative tools. “Excess” means selected outside this rubric's required/acceptable set, not unauthorized execution. Always-on inspection/recovery tools are counted separately.

| Metric | Current Jev | Frozen candidate |
| --- | ---: | ---: |
| Raw required intent choices | 42/54 (77.8%) | 50/54 (92.6%) |
| Final required intent choices | 34/54 (63.0%) | 41/54 (75.9%) |
| Raw required tool choices | 33/69 (47.8%) | 59/69 (85.5%) |
| Final required tool choices | 58/69 (84.1%) | 59/69 (85.5%) |
| Explicit required skills selected and loaded | 6/6 | 6/6 |
| Rubric-excess tool selections | 968 | 532 |
| Intent + capability decision latency, median / p95 | 1,182 / 1,432 ms | 1,175 / 1,423 ms |
| Recorded provider failures | 0 | 0 |

Final required-tool recall by trial: baseline **19/23, 20/23, 19/23**; candidate **20/23, 19/23, 20/23**. Every candidate trial is below the predeclared **95%** gate. Trial 2 is also below its baseline counterpart. Aggregate improvement does not qualify the candidate for release.

Candidate unnecessary tool exposure fell **45.0%**, but the fixture still sometimes exposes much of the catalog. The `researcher` and `wiki-builder` skills declare broad `core` dependencies, which the capability selector adds even when Jev rejects individual tools. That is a dependency/exposure issue, not simply poor model probability calibration. No dependency or authorization policy was weakened during this experiment.

Probability bins and positive/negative Brier scores are included in the machine-readable evidence. Optional and alternative candidates are excluded from those probability labels. The many negative catalog candidates and small request sample make a single overall accuracy or calibration score misleading. Do not interpret these bins as population-wide confidence guarantees.

## Confirmed failure mechanisms

### 1. Deterministic request parsing overrides correct Jev answers

These were reproduced directly against current source, without a provider:

| Request | Actual parser result | Consequence |
| --- | --- | --- |
| `Open https://example.com in the browser and take a screenshot.` | No nonempty explicit segments | Jev's accepted browser intents are removed. Arabic with the same URL behaves similarly. |
| `Read before.md and after.md from this workspace and explain the factual differences. Do not modify either file.` | No nonempty explicit segments | Jev's accepted repository-inspection intent is removed. |
| `Forget the previous research task. Just explain what a citation is, without tools.` | A new research requirement | The runtime adds research and removes conversation despite the changed objective. |

`src/runtime/request-requirements.ts` applies an informational-word regex to whole segments. The word `example` also matches a URL hostname; `explain` invalidates the preceding read instruction. Its research detector recognizes a topic mention inside “forget the previous research task” as a new obligation. `src/runtime/jev/live-routing.ts` then uses those results to filter or force labels. This explains why final intent recall can be lower than raw Jev recall.

These gates should be repaired at their shared request-parsing boundary with paired action/information, negation, quoted-text, URL and Arabic tests. Giving Jev unconditional precedence would hide the defect and risk bypassing explicit restrictions. No such bypass was introduced.

### 2. Uncertain relevant tools have no useful fallback

In all three candidate trials, the English existing-task request omitted `task.status` and `task.result.read`; their probabilities were approximately 0.74–0.78. All three search-setup requests omitted `config.web.setup` at approximately 0.54–0.56. One Arabic task-status trial omitted `task.status` at 0.79. These account for all ten missing required choices. Standard did not recover them.

The calibration set separately missed `terminal.run` for inspecting the git diff, despite selecting terminal inspection. Tool descriptions, request-to-tool relationships, and Standard fallback coverage need work before another threshold selection. A blanket threshold reduction is not supported by this experiment.

### 3. Broad dependencies obscure capability-selection quality

A loaded skill can require entire toolsets, adding many tools the independent model decisions rejected. Report both raw choices and actual exposure. Review whether those skill dependencies are truly required, keeping session visibility and execution authorization intact. The experiment did not remove them just to improve its exposure score.

## What should happen next

1. Fix the three shared request-parsing defects with narrow regression tests and preserved negative/quoted boundaries.
2. Improve task inspection, search setup and git-diff capability descriptions/fallback coverage, using the observed failures as development cases.
3. Review broad research skill dependencies separately from threshold tuning.
4. Freeze a new candidate and evaluate a **new, untouched acceptance set**. This acceptance set is now diagnostic material, not an unbiased future release gate.
5. Only after semantic acceptance passes, test the rebuilt app and gateway together: Standard/Jev toggle, actual build identities, routing facts, recovery, approvals, and a real research/delegation/save/read-back workflow.

The proposed packaged-candidate test was conditional on semantic acceptance. It was not run because the candidate failed that prerequisite. There is no newly calibrated build to install.

## Evidence and reproduction

- Corpus: [`assets/evals/jev-routing-v1.json`](../../assets/evals/jev-routing-v1.json).
- Measurements, frozen gate, experiment summaries, all held-out selections/probabilities, trace hashes and limitations: [`evals/results/jev-calibration-v1.json`](../../evals/results/jev-calibration-v1.json).
- Runner: [`scripts/run-jev-calibration.ts`](../../scripts/run-jev-calibration.ts).
- Full local raw trace archive: `/tmp/estacoda-jev-calibration-evidence-2026-10-14.tar.gz` (temporary storage; compact acceptance evidence above is retained in the repository).

Live evaluation requires the selected profile to enable a pinned Jev model and uses its normal credential resolver. It writes its usage ledger and synthetic traces only in the explicit output directory. `--live` sends billable provider requests; replay does not. Replay currently also requires that profile configuration, but does not resolve credentials or call the provider. Use fresh output directories for changed experiments; resuming rejects mismatched provenance. A live result resumed from disk is included in cumulative experiment usage, not charged again by the runner.

```sh
pnpm run eval:jev --live --split development --variant baseline --output /tmp/my-jev-baseline
pnpm run eval:jev --live --split development --variant scoped-work --accept .8 --reject .3 --tool-accept .8 --tool-reject .4 --output /tmp/my-jev-candidate
pnpm run eval:jev --replay /tmp/my-jev-candidate --split development --variant scoped-work --accept .8 --reject .3 --tool-accept .8 --tool-reject .4 --output /tmp/my-jev-replay
```

Replays verify question/context hashes and catalog identity and reject unconsumed/mismatched records. They can rescore an explicitly revised label corpus, recording the source corpus hash. Expected labels stay outside provider requests. The local raw archive contains the earlier full replay inputs; compact evidence is sufficient to independently rescore accepted selections but does not replace full routing replay inputs.

## Validation and risk

Validation completed in an isolated copy of tracked `ec423b65` plus the evaluation changes, preserving unrelated working-tree changes:

- Locked dependency installation passed. The offline attempt lacked a cached package; normal installation succeeded without lockfile changes.
- Focused evaluation, Jev boundary, request-interpretation and tool-narrowing tests: **196 passed**.
- Full core suite after correcting isolated workspace dependency links: **12,354 tests passed across 763 files**. The first sandboxed attempt could not bind local test servers; the unrestricted rerun exposed one borrowed-workspace link identity failure, resolved by the isolated locked install. No source assertions were weakened.
- Core typecheck and a separate typecheck covering the evaluation script passed.
- Source smoke: **13 passed**. Build, runtime-import audit and ESM audit passed. Compiled smoke: **13 passed**.
- Offline replay reproduced all **60 candidate acceptance case-trials** exactly; a deliberately mismatched question variant was rejected with a nonzero exit.
- Diff/whitespace checks passed. Reviewed new evidence for credentials and private paths; none were present.

These software checks passing do not change the failed live routing acceptance decision. This change adds evaluation-only tooling and evidence; no production routing policy, authorization, setup, credential or installed build changes are made. The live runner crosses the provider network boundary using existing governed credential and usage paths. Its fixture makes all catalog members selectable, so its results must not be represented as a readiness or permission test.

## Research informing the experiment

TypeSafe recommends application-specific thresholds and empirical validation of [confidence scores](https://docs.typesafe.ai/confidence). Its [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) support testing explicit wording rather than assuming generic instructions are interpreted consistently. The [skill suggestion example](https://docs.typesafe.ai/cookbooks/skill_suggestion) is informative, but its selection constraints do not replace EstaCoda's independent multi-skill requirement. Repeated trials, inspecting traces, and separating outcomes from agent claims align with Anthropic's [agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). The numbers in this report come from EstaCoda's own experiment, not those examples.
