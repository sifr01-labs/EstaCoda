# Managed command and research acceptance live checks — 2026-11-06

Baseline: `62246ec5afb60cde7d1a9cb4d57b0bcfb421f1b2`, branch `ame/jev-assisted-routing`.
Model: configured Codex `gpt-6.1-sol`, with no fallback. Every run used a fresh isolated profile, conversation and workspace. No existing conversations or personal skills were supplied. These are actual model calls through EstaCoda's foreground planner, durable workers, scheduler and result/export machinery, with real subprocesses and repository tests. They do not exercise Telegram transport.

## Paired results

| Work | Baseline | Updated candidate |
| --- | --- | --- |
| Original Superagent + Harness vs EstaCoda request | Partial; no accepted workers: two rejected for repository evidence, one for a fixture-induced unresolved test; synthesis/export skipped | Completed; all three worker reports accepted; synthesis and deterministic export completed |
| Delegated audit of known command-completion/summary source paths and their existing tests | Tests exited zero, but worker report rejected for repository evidence; synthesis skipped | Completed; one-second observation wait returned a process ID, polling the same ID collected exit zero; worker and synthesis accepted |

The updated broad run exported **33,192 bytes**, with SHA-256 `c5c5e661655f3d854626c85ed720b80fa9d51c41ee8307a8075a1e71a4cf4bed`, exactly matching its accepted synthesis. The baseline exported no report. Original subject source files were unchanged in both arms.

| Work / arm | Elapsed | Provider requests | Recorded input + output tokens |
| --- | ---: | ---: | ---: |
| Comparison / baseline | 582,986 ms | 70 | 1,737,155 |
| Comparison / updated | 668,251 ms | 99 | 2,144,092 |
| Focused audit / baseline | 324,465 ms | 20 | 301,944 |
| Focused audit / updated | 227,629 ms | 19 | 221,452 |

The models selected different test subsets. The baseline EstaCoda worker retained an unresolved verification obligation, separate from the two upstream discovery-gate failures; its selected MCP test required `docs/subsystems/mcp.md`, which the fixture omitted. This was a benchmark preparation defect, not a production bug or an obligation cleared by this patch. The updated model selected different tests. The two upstream failures and the focused paired audit independently exercise the unnecessary discovery requirement. The broad updated run did more accepted work and used more time/inference. This is evidence of completion improvement on these tasks, not a speed/cost win or a statistical success-rate estimate. Pricing is incomplete; no dollar comparison is made.

## Final-snapshot verification

The focused audit was repeated after compatibility fixes: **completed**, 17 provider requests, 251,514 ms, 191,942 input + output tokens. The real model selected `waitMs: 1000, timeoutMs: null`, received a running process, then read the same process's exit zero without starting the command again. See `final/after/continuation/command-receipts.json` and its accepted reports.

The broad task was also repeated on that snapshot with the benchmark manifest clarification below: **completed**, all three workers accepted, synthesis and export completed, 100 provider requests, 659,147 ms. The exported **37,415-byte** report exactly matches the accepted synthesis: SHA-256 `e4accb084da63301c0fbfc221dd086dfe0b79df9ad2b40a0e3e5cc7a0bc43bb4`. See `final/summary.json` and `final/after/comparison/`. Both updated broad runs completed; both updated focused runs completed. Two baseline runs remained partial. These six runs are small mechanism checks, not a general reliability estimate.

## Method and limitations

- Both arms inspected the same pinned baseline EstaCoda subject source. The runtime under test differed. The temporary Git revision identifies the fixture including benchmark instructions, not the upstream EstaCoda commit.
- Prepared public checkouts: Superagent `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`; Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Dependency availability was equal; these were not deployed services. Live web fetching was disabled. The original broad request was unchanged.
- The focused audit deliberately supplied known paths and requested a short observation wait, without prescribing `waitMs` or fabricating tool results. It exercises a particular failure mechanism; it is not an unconstrained benchmark.
- The collected runs used a source/test fixture without the repository documentation directory. Future preparation in `run.mjs` now includes the baseline documentation to prevent the missing-MCP-doc prerequisite failure above; historical results are unchanged. This limits broad-run causal attribution, although the updated runs genuinely completed their selected source/tests and export.
- The initial fixture manifest included updated-runtime hashes alongside the unchanged subject checkout. The updated report correctly noted hash disagreement, but those hashes described a different object. The final broad rerun uses explicitly named `subjectSourceHashes` and keeps runtime hashes outside the inspected workspace. No source or tests were changed to repair that description. Initial runs and their reports are retained rather than silently replaced.
- The first updated snapshot preceded the mutually exclusive wait/deadline validation and canonical-CWD interoperability fix. The repeated final-snapshot runs include those fixes. Recorded hashes identify each snapshot. Subsequent changes to test coverage, documentation and the non-managed tool description do not change the managed path used by these runs.
- Native test counts in the generated comparisons measure selected repository checks. They do not establish comparative coding performance of EstaCoda, Hermes or DeepSeek.
- `run.mjs` records full raw evidence only in its fresh temporary directory and removes copied credentials in `finally`. `collect.mjs` retains sanitized reports, summaries, source hashes and bounded command receipts here; raw databases and credentials are excluded. Command receipt tails are excerpts with a full-content hash, not complete transcripts.

## Regression and standard validation

- 296 targeted tests passed across managed commands, diagnostic disclosure, worker acceptance, scheduler settlement, completion checks, runtime registration and Python execution.
- The standard full suite: **13,534 passed, one failed** across 789 files. The remaining `src/control-service/evolution-toolchain.test.ts:14` assertion also fails on the unchanged baseline in the same environment. A subsequently added scheduler deadline/uncertainty case passes in the targeted run.
- Frozen dependency installation, typecheck, smoke, build, runtime-import audit, ESM audit, distribution smoke and `git diff --check` passed. Initial restricted-environment socket failures were rerun with local service access; they did not remain in the full-suite result above.
- Real-process regressions verify that an explicit hard deadline stops a command after an earlier write, retains its receipt, and does not report a known successful outcome. Scheduler tests retain uncertainty and diagnostics through deadline settlement, forbid blind retry and new writes, and allow only independent work with enforced read-only authority to drain.

## Reproduction

With authorized Codex credentials, existing dependencies and the prepared upstream checkouts described in `run.mjs`:

```sh
node --import tsx evals/results/managed-command-live-2026-11-06/run.mjs /private/tmp/estacoda-managed-command-NEW prepare
node --import tsx evals/results/managed-command-live-2026-11-06/run.mjs /private/tmp/estacoda-managed-command-NEW before
node --import tsx evals/results/managed-command-live-2026-11-06/run.mjs /private/tmp/estacoda-managed-command-NEW after
```

`BENCHMARK_CASE=comparison` or `BENCHMARK_CASE=continuation` selects one case. These calls consume the configured account's inference allowance. Test-running alone does not send Telegram messages or authorize a push/deployment.
