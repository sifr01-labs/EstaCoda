# Research acceptance and qualified synthesis — 2026-11-07

## Change and limits

Baseline: `527dd102366151f5ae0c6329c658d1466ba8d11b`. Updated snapshots are identified by file hashes in each manifest. This packet tests production EstaCoda planning, delegated workers, result reads, settlement and deterministic export using actual **Codex gpt-6.1-sol** requests and real repository commands. No scripted model was used for these live runs.

Incomplete research workers now preserve bounded, sanitized, host-produced source observations separately from their unaccepted prose. Synthesis must completely read integrity-matching packets from its assigned dependencies. Failed checks remain unresolved, failed workers remain failed, and overall incomplete work remains partial. These observations support narrow source findings, not an automatic proof of arbitrary claims. No authority or approval boundary is widened.

Citation validation now names unmatched URLs and permits bounded correction. Placeholder-only correction disables tools and can use remaining finalization allowance. This exact abbreviation case was verified with a production-loop integration test using a scripted provider; it was **not encountered in the real-provider runs below**.

## Actual runs

| Run | Model requests | Elapsed | Result |
| --- | ---: | ---: | --- |
| Baseline, missing-dependency policy investigation | 22 | 338 s | Worker failed; synthesis/export skipped; no report |
| Exploratory updated, broad original comparison | 96 | 505 s | Three source workers accepted; synthesis/export completed |
| Exploratory updated, missing dependency | 29 | 227 s | Observation packet retained, but synthesis/export still skipped; exposed scheduler admission gap |
| Final updated, same missing-dependency request | 30 | 296 s | Worker failed correctly; synthesis read source packet, completed and exported qualified policy report; task partial |

The exploratory failure is retained. It led to the scheduler change allowing qualified synthesis from host observations even when all workers failed. The final run includes that correction. The broad run preceded that correction and the final refinement of text-only repair; see the separate source manifests.

The final policy report is **11,725 bytes**, SHA-256 `41eeaa83e4b2248f7b5d4df2dce858e161b32d93d9f74444e572b3f621c489a3`, and matches the accepted synthesis exactly. The source packet was read in two pages (offsets 0 and 20,000; final total 37,158 characters). The report retains concrete source findings, distinguishes authored tests from executed behavior, discloses truncated excerpts, and explicitly leaves `prototype-policy-tests` unresolved. Vitest exited 1 because `zod` was absent; no policy tests ran. The test request intentionally prohibited installation and required this single attempt to reproduce the acceptance failure. That is a controlled real-work failure scenario, not recommended dependency preparation.

The broad report is **34,797 bytes**, SHA-256 `2f6b6a7318e4e4ad8fb2cab3df5b60d57e3943c7c124b96f67a4d237cce1d8ff`, matching accepted synthesis. Superagent prepared its own dependencies and reported **535 passing targeted tests**. Harness dependency preparation did not finish during its investigation, and it did not execute behavior tests. Its source findings survived and its limitations were disclosed. The runtime marked this workflow completed; that does **not** establish a complete comparative benchmark.

Pinned upstream inputs: Superagent `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`; Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Both focused arms used the same prompt, pinned source, missing dependencies, tools and budgets. Original fixture source files were unchanged in all runs. Generated reports and dependency files are excluded from that original-input comparison.

Final focused usage: 531,868 input + 12,233 output tokens; baseline 404,023 + 15,011. This single pair demonstrates recovered coverage/delivery, **not lower inference cost or established statistical reliability**. Broad updated usage: 2,081,787 input + 22,614 output. No Hermes performance comparison was run.

No Telegram transport, configured search provider, Kimi fallback, or general self-improvement outcome was tested. Public extraction was enabled. Upstream checkouts were fresh clones from pinned local caches, with original Git history/remotes and no installed dependencies. The production model worked on the actual source files; this is not a deployed upstream agent trial.

## Evidence and reproduction

- `exploratory/`: baseline focused run, broad updated run, and exploratory focused failure.
- `final/after/continuation/`: final qualified report, source observation JSON, source-result page reads, validation events and command receipts.
- Each compact summary records task/step statuses, usage, result hashes, export equality and original fixture changes.
- Report exports preserve exact bytes. Diagnostic and accepted-result presentation copies normalize trailing whitespace; their original hashes remain in summaries. Raw session databases, credentials and full transcripts are excluded. Temporary credential copies were removed after each run.

`run.mjs` prepares isolated source snapshots and profiles. It requires configured Codex OAuth and local upstream Git caches at the explicit paths in the runner. Do not run against a personal profile or send these fixtures to Telegram.

```sh
node --import tsx evals/results/research-acceptance-live-2026-11-07/run.mjs /private/tmp/estacoda-research-acceptance-NEW prepare
# BENCHMARK_CASE selects comparison or continuation; omit to run both.
BENCHMARK_CASE=continuation node --import tsx evals/results/research-acceptance-live-2026-11-07/run.mjs /private/tmp/estacoda-research-acceptance-NEW before
BENCHMARK_CASE=continuation node --import tsx evals/results/research-acceptance-live-2026-11-07/run.mjs /private/tmp/estacoda-research-acceptance-NEW after
```

## Validation

- Focused evidence/executor/provider/integration checks: 364 passed before final scheduler additions.
- Scheduler: 65 passed, including observation-only synthesis admission and rejection of ordinary diagnostic drafts.
- Research integration: 59 passed, including exact abbreviated-URL repair with tools disabled.
- Provider loop: 190 passed, including bounded textual repair during finalization and ordinary repair remaining blocked there.
- Frozen install, typecheck, source smoke, build, runtime import audit, ESM audit, distribution smoke, skill catalog generation and diff check passed.
- Full suite: **13,549 passed, one failed** across 790 files. The remaining `src/control-service/evolution-toolchain.test.ts` failure was independently reproduced on unchanged baseline `527dd1023`; it concerns the installed pnpm/toolchain environment. Full-suite success is not claimed.

The live runs establish this recovery path works on a real delegated source investigation. They do not establish that every upstream test environment can be prepared, every citation is semantically true, or the original broad comparison now finishes reliably across repeated trials.
