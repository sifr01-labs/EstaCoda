# Jev routing reliability repair — 14 October 2026

Historical result for the repair at `09c333e1`. The subsequent [round-three calibration](jev-calibration-round-3.md) passed fresh gates and promoted a new question/threshold policy; the measurements below describe the earlier unchanged policy.

The runtime now preserves actionable requests that the parser previously discarded, exposes specific read-only inspection prerequisites, and removes the broad core dependency from researcher/wiki-builder. This is a focused runtime repair. The experimental Jev questions and thresholds were **not promoted**, and full model calibration remains incomplete.

## Implemented behavior

- URL words such as `example` no longer cancel browser requests. A later explanation clause no longer erases an earlier file-read instruction. Filenames are operands, not new research requests.
- Cancelling an old research objective does not create a new research obligation. Quoted instructions, examples, hypothetical questions, prohibitions and capability questions remain non-executable unless a separate actionable clause exists. English and Arabic regressions are covered.
- Candidate-level uncertainty fallback retains Standard's `taskClass`, including when that class is absent from its label array. Confident Jev rejection remains distinct from uncertainty.
- Explicit task-status/result, search-settings and git-inspection requests retain the corresponding existing read-only tools in both Standard narrowing and Jev selection. Availability, session catalog filtering, schema budgets and execution authorization still apply.
- The existing `config.provider.status` describes saved web network/search/extraction settings without changing them or claiming connectivity was tested. Tool descriptions distinguish inspection from mutation.
- Researcher/wiki-builder require `files` and `research`, rather than the entire `core` toolset. The existing session-authorized `task.status` and `task.result.read` tools now belong to `research` too, preserving delegated-result and save-follow-up continuity. Export and mutation tools were not added to this toolset.

## Benchmark corrections

Source review found two false expectations in the first experiment:

1. `web-setup` explicitly forbids changes. It should expect read-only `config.provider.status`; `config.web.setup` mutates configuration and can enable network access.
2. `diff-review` can use `terminal.inspect`, which already supports safe `git diff`. Requiring general `terminal.run` was incorrect.

The original corpus/results are retained as historical evidence, with a correction at the top of the [original report](jev-calibration-report.md). Corrected original acceptance tool recall is **61/69 baseline versus 59/69 experimental candidate**. That candidate remains rejected. All previously seen cases are development cases in the new corpus.

## Fresh live comparison

The frozen v2 corpus adds 20 new acceptance phrasings, evaluated three times on unchanged `ec423b65` and on the final repair. They share task families with development cases; they are a focused regression check, not an independent population-wide calibration benchmark. Expected answers are never sent to Jev.

Both runs used pinned `jev-1.13.0`, existing production questions, acceptance ≥0.8 and rejection ≤0.2. No thresholds or questions were tuned against these acceptance cases. The fixture loads bundled skills and 109 registered tool definitions; benchmark tools are **not executed**.

| Metric, aggregated across three trials | Unchanged runtime | Final repair |
| --- | ---: | ---: |
| Required tool choices exposed | 81/84 | **84/84** |
| Required tools per trial | 27/28 each | **28/28 each** |
| Required intent labels retained | 21/51 | 33/51 |
| Required explicit skills selected and instructions loaded | 12/12 | 12/12 |
| Rubric-excess tool selections | 1,536 | 1,564 |
| Rubric-excess skill selections | 0 | 6 |
| Routing latency, median / p95 | 1,139 / 1,255 ms | 1,130 / 1,312 ms |
| Recorded provider failures | 0 | 0 |

The baseline missed Arabic task-result reading in all three trials. The final repair misses no required tool choices. For the first research-worker/wiki trials, exposed tool counts fell from 100/100 to 86/85. This does **not** establish an overall reduction: permitting valid browser requests also revealed Jev selecting the unrelated dogfooding skill, and total excess selections increased. Intent recall remains only 64.7%; many conversation labels are still rejected. Raw Jev required-tool acceptance is 34/84, so final recall depends heavily on Standard fallback and explicit/skill prerequisites.

One intermediate patched evaluation was run before review completed. Review caught the lost delegated-result dependency and a hypothetical-clause edge case; both were fixed and covered before the final run. Across baseline, intermediate and final runs: **540 provider requests, 5,131,638 reported tokens, estimated US$0.192879**. This is ledger-estimated cost, not an invoice. All three runs are retained in the local archive; baseline/final case selections, probabilities and trace hashes are retained in repository evidence.

## Validation and review

Checks ran in an isolated copy of tracked source plus this change because the working checkout contains unrelated changes and duplicate untracked source files.

- Full core suite: **12,396 tests across 763 files passed**.
- Delegated research, restart, save-only follow-ups, synthesis, file write/read-back, toolset security and task authorization subset: **132 passed**.
- Frozen dependency installation, core typecheck and separate evaluation-runner typecheck passed. An offline install first aborted for a noninteractive modules-directory prompt; normal frozen installation passed without dependency or lockfile changes.
- Source smoke, build, runtime-import audit, ESM audit and compiled smoke passed.
- Offline replay exactly reproduced all 60 final case-trials, with zero provider calls.
- Skill catalog was intentionally regenerated. Existing catalog metadata warnings remain; generated dependency changes match the two skills.
- Review preserved negative/quoted/hypothetical boundaries and verified that exact tool prerequisites cannot add unavailable tools. No credential, profile, permission, command allowlist or approval policy changed.

The first broad test run caught two missing task-result-read follow-ups and an old characterization assertion requiring the schema budget to be filled with unrelated core tools. The dependency was restored narrowly; the characterization now checks the upper bound, required tools and absence of unrelated core fillers. The final full suite passed.

Risk: request parsing and tool selection are security-sensitive. These changes influence exposure, not execution authority. Existing task-session authorization and safe git-inspection validation remain enforced. Live fixture evaluation is not proof of real tool readiness, external MCP behavior, or packaged Desktop/gateway operation. The app and gateway were not rebuilt or installed in this change.

## Evidence and reproduction

- [Corrected corpus and fresh cases](../../assets/evals/jev-routing-v2.json)
- [Measurements, frozen gates, source hashes and case-level evidence](../../evals/results/jev-routing-repair-v2.json)
- [Evaluation runner](../../scripts/run-jev-calibration.ts)
- Local full synthetic trace archive: `/tmp/estacoda-jev-routing-repair-evidence-2026-10-14.tar.gz`. The repository evidence records its hash; the archive excludes credential files and usage databases.

```sh
# Billable calls using the selected profile's configured pinned Jev model.
pnpm run eval:jev --live --corpus assets/evals/jev-routing-v2.json --split acceptance --repeat 3 --variant baseline --output /tmp/new-jev-repair-check
# No provider calls. Use a matching source/catalog and the recorded output above.
pnpm run eval:jev --replay /tmp/new-jev-repair-check --corpus assets/evals/jev-routing-v2.json --split acceptance --repeat 3 --variant baseline --output /tmp/new-jev-repair-replay
```

Resume rejects mismatched source/configuration/corpus/catalog/threshold provenance. Replay checks exact question/context hashes. The final catalog fingerprint covers skill instructions/dependencies and tool schemas/risk/toolsets. The baseline was recorded before this fingerprint strengthening, so its catalog hash is not directly comparable; the recorded source revision and traces identify that run.

Next calibration work must address intent misses and irrelevant skill/tool selection on development data, then freeze another untouched acceptance set. A packaged acceptance run must verify both app and gateway build identities and exercise actual research, delegation, source verification, saving and read-back before claiming end-to-end release validation.
