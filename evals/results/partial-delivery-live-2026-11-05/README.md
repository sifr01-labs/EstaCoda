# Partial delivery and review recovery: live A/B

Baseline: `65cef7f154d721ad73a779efaf2066b1d99bd488`. Updated arm: this patch; exact runtime source hashes are in `ready/manifest.json`. Model: configured Codex `gpt-6.1-sol`, no fallback. Runs began November 5, 2026 UTC.

## Result

The controlled foreground case demonstrates the delivery fix. The larger comparison does **not** demonstrate improved end-to-end completion; the updated arm stopped earlier than the baseline.

| Case | Baseline | Updated |
| --- | --- | --- |
| Foreground source audit with one missing integration dependency | 118-character validation notice; useful draft absent | 8,252-character response containing the notice and explicitly unaccepted draft |
| Foreground verification | 51 actual tests passed; integration check unresolved; partially completed | Same 51 tests passed; integration check unresolved; partially completed |
| Original DeepSeek comparison prompt | Partial task; two accepted research scopes, one diagnostic scope, synthesis and exact report export | Waiting for input after terminated test command; one accepted research scope, no synthesis/export |
| Comparison report | 29,901 bytes; saved bytes match accepted synthesis hash | No exported report |

Foreground calls were 19 before / 20 after; cumulative input tokens 310,285 / 317,860. This is a delivery improvement, not an efficiency win. Comparison calls were 95 / 40 and input tokens 1,984,443 / 832,814; the smaller updated totals reflect unfinished work, not better efficiency. Pricing is incomplete; no dollar-cost claim is made.

## What the larger failure shows

The updated Super-agent worker chose `timeoutMs: 1000` for a real six-file Vitest invocation. The process was terminated after one second (code 143), after reporting only two files. The task recorded uncertain effects and paused for operator review. The worker produced prose, but that prose was ineligible for diagnostic publication under the existing uncertain-effect boundary. The Harness worker completed and published 16,211 accepted bytes. The EstaCoda worker had not started; synthesis and export remained pending.

The baseline completed both external investigations, but the EstaCoda worker failed the repository-evidence contract. Its draft survived diagnostically; synthesis and export completed with partial coverage. Neither arm completed the full requested investigation. One run per arm is insufficient to attribute the different model choices to the patch or estimate a success rate. No automatic retry or authority override was used to conceal these results.

This leaves a concrete separate issue to investigate: reliable long-running command selection and evidence-based reconciliation of terminated local test processes. The patch does not assert that unknown effects are harmless.

## Method and limits

- Fresh isolated profiles and workspaces; no personal conversations or skills; temporary Codex authentication removed after runs. No Telegram messages were sent.
- Real production runtime, model requests, tool handlers, workers and scheduler. Existing source/test suites were executed. Task host driving used the test runner, not the Telegram gateway/supervisor lifecycle.
- Both arms inspected identical baseline EstaCoda source. Upstream checkouts and dependencies were prepared equally. Super-agent revision `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`; Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Upstream Git metadata was not copied; workers received `UPSTREAM.json`. Dependency directories were linked to prepared local installations, not separately installed per arm.
- Web fetching was disabled; this tests investigation against supplied pinned sources, not finding the latest public project from scratch. No competing harness or matched coding-performance benchmark ran.
- Foreground case explicitly requests a real source audit plus a controlled missing optional dependency. It is not a verbatim replay of the Telegram incident. Neither arm was allowed to install that dependency or alter the fixture.
- Provider allowance: 45 iterations, 65 tools, 600 seconds, 20-second finalization reserve. Existing task limits and authorization remained enforced.
- Restart recovery, stale-claim fencing, authority revocation, workspace exclusion and supervisor retention were verified by regression tests, not a live crash/restart experiment. Applied learning and improved subsequent task performance remain unproven by these runs.
- The as-run manifest's inherited `scope` text mentions unused budget/ledger fixtures. Only the two entries in its `cases` object ran; there was no lowered-token-budget or ledger-learning arm. Unused fixture setup remains in the runner to preserve the exact tested inputs.
- `network-pilot/` retains four infrastructure-failed attempts before network-enabled execution. They are not research outcomes. One additional baseline foreground launch raced fixture preparation and failed before runtime creation; the ready run was restarted after preparation completed.

## Evidence and reproduction

`ready/summary.json` contains all four main outcomes, usage and result dispositions. Per-arm foreground JSON preserves delivered text. Report files retain accepted/diagnostic labels. `ready/selected-tool-receipts.json` contains successful test receipts, the missing integration dependency, and the timed-out upstream invocation. Raw session databases and account credentials are intentionally excluded.

With configured Codex OAuth, installed repository dependencies and prepared upstream clones at the runner's explicit temporary paths:

```sh
node --import tsx evals/results/partial-delivery-live-2026-11-05/run.mjs /private/tmp/estacoda-partial-delivery-live-FRESH prepare
BENCHMARK_CASE=foreground node --import tsx evals/results/partial-delivery-live-2026-11-05/run.mjs /private/tmp/estacoda-partial-delivery-live-FRESH before
BENCHMARK_CASE=foreground node --import tsx evals/results/partial-delivery-live-2026-11-05/run.mjs /private/tmp/estacoda-partial-delivery-live-FRESH after
```

Use `BENCHMARK_CASE=comparison` for the larger case. The runner copies baseline source and overlays the patch. It requires network access for the explicitly configured model; fixture web tools remain disabled.

## Repository validation

Final full suite: **13,530 passed, one failed**, across 789 files. The remaining failure is `src/control-service/evolution-toolchain.test.ts:14`; the same assertion fails on the unmodified baseline in this environment. The suite is therefore not fully green. Earlier runs exposed old assertions about ordering and suppression; those were updated to assert the new behavior and retained incomplete status, then the full suite reran.

Frozen-lockfile installation, typecheck, build, source smoke, distribution smoke, runtime-import audit, ESM audit and whitespace checks passed. Focused recovery tests cover incomplete checks, missing readback, secret/reasoning removal, uncertain effects, denied-only work, durable review jobs, interrupted claims, disposal and crowded capability selection. No approval, execution or promotion boundary was widened.
